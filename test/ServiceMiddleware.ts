import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import type { Hex, PublicClient } from "viem";
import { AgenticWorld, type AgenticRequest, type Session } from "../sdk/service.js";
import { CLONE_PREFIX, CLONE_SUFFIX, sessionProofHeaders, type AuthenticationChallenge, type AuthenticationProof } from "../sdk/core.js";

test("SDK middleware offers authentication only on opted-in routes and rechecks resource permissions", async () => {
  const agentId = "0x1111111111111111111111111111111111111111";
  const token = "a".repeat(43);
  const hash = `0x${createHash("sha256").update(token).digest("hex")}` as Hex;
  const sessions = new Map<Hex, Session>([[hash, { agentId, expiresAt: 200 }]]);
  let now = 100;
  let user: { report: boolean } | null = { report: false };
  let failStore = false, failPermission = false;
  let handlerCalls = 0, permissionCalls = 0;
  const service = new AgenticWorld({
    client: {} as PublicClient, // HTTP session requests must not touch the chain.
    chainId: 31337, pinnedImplementation: "0x2222222222222222222222222222222222222222", audience: "https://service.example",
    association: { mode: "manual", resolveUser: async () => user }, now: () => now,
    challenges: { async put() { throw new Error("Discovery is not nonce issuance"); }, async get() { return undefined; }, async consume() { return false; } },
    sessions: { async put(key, value) { sessions.set(key, value); }, async get(key) {
      if (failStore) throw new Error("database credentials: must not leak");
      return sessions.get(key);
    } },
  });
  const middleware = service.middleware({ realm: 'Reports "private"',
    authorize: ({ user: resolved }) => {
      permissionCalls++;
      if (failPermission) throw new Error("permission backend failed");
      return resolved.report;
    } });
  const server = createServer(async (request, response) => {
    if (request.url === "/public") { response.end("public report"); return; }
    if (request.url === "/oauth") {
      response.writeHead(401, { "WWW-Authenticate": 'Bearer realm="human-login"' }).end("OAuth required"); return;
    }
    try {
      await middleware(request, response, () => {
        handlerCalls++;
        assert.equal((request as AgenticRequest<{ report: boolean }>).agentic?.session.agentId, agentId);
        if (request.url === "/handler-error") throw new Error("application error");
        response.end("private report");
      });
    } catch { response.writeHead(500).end("Application error handler"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (session?: string, path = "/private/report") => fetch(`${base}${path}`, { headers: session ? { "Agent-Session": session } : {} });
  try {
    const available = await request(undefined, "/public");
    assert.equal(available.status, 200);
    assert.equal(available.headers.get("www-authenticate"), null);
    const oauth = await request(undefined, "/oauth");
    assert.equal(oauth.status, 401);
    assert.equal(oauth.headers.get("www-authenticate"), 'Bearer realm="human-login"');
    assert.equal(await oauth.text(), "OAuth required");
    for (const invalid of [undefined, "bad-token", "b".repeat(43)]) {
      const response = await request(invalid);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate")!, /^AgenticWorld realm="Reports \\"private\\""/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual((await response.json()).authentication, { scheme: "AgenticWorld", audience: "https://service.example",
        transport: "resource" });
    }
    assert.equal(permissionCalls, 0);
    assert.equal(handlerCalls, 0);
    const denied = await request(token);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("www-authenticate"), null);
    user = { report: true };
    const allowed = await request(token);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("www-authenticate"), null);
    assert.equal(await allowed.text(), "private report");
    user.report = false;
    assert.equal((await request(token)).status, 403, "permission removal affects the same session immediately");
    user = null;
    assert.equal((await request(token)).status, 403, "removed association is not another authentication challenge");
    user = { report: true };
    failStore = true;
    const failed = await request(token);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("www-authenticate"), null);
    assert(!((await failed.text()).includes("credentials")));
    failStore = false; failPermission = true;
    assert.equal((await request(token)).status, 503);
    failPermission = false;
    assert.equal(handlerCalls, 1, "failures must never reach the resource handler");
    const applicationError = await request(token, "/handler-error");
    assert.equal(applicationError.status, 500);
    assert.equal(await applicationError.text(), "Application error handler");
    now = 200;
    const expired = await request(token);
    assert.equal(expired.status, 401);
    assert.match(expired.headers.get("www-authenticate")!, /^AgenticWorld /);
    assert.throws(() => service.middleware({ realm: "bad\r\nheader", authorize: () => true }), /realm/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("resource middleware issues challenges, accepts proofs on the same URL, and fails closed", async () => {
  const agentId = "0x1111111111111111111111111111111111111111";
  const implementation = "0x2222222222222222222222222222222222222222";
  const challenges = new Map<Hex, AuthenticationChallenge>();
  const sessions = new Map<Hex, Session>();
  const consumed = new Set<Hex>();
  let now = 100, failRpc = false, failStore = false, calls = 0;
  let signatureValid = true, allowed = true, associated = true, admitted = true;
  const service = new AgenticWorld({
    // Transport/error-path fixture; DemoService/McpE2E test real P-256 ERC-1271.
    client: {
      getChainId: async () => { if (failRpc) throw new Error("secret RPC credentials"); return 31337; },
      getBlockNumber: async () => 1n,
      getCode: async () => `${CLONE_PREFIX}${implementation.slice(2)}${CLONE_SUFFIX}`,
      readContract: async () => signatureValid ? "0x1626ba7e" : "0xffffffff",
    } as unknown as PublicClient,
    chainId: 31337, pinnedImplementation: implementation, audience: "https://service.example", now: () => now,
    association: { mode: "manual", resolveUser: async () => associated ? { allowed } : null },
    authorizeSession: async () => admitted,
    challenges: {
      async put(value) { if (failStore) throw new Error("secret database credentials"); challenges.set(value.nonce, value); },
      async get(nonce) { return challenges.get(nonce); },
      async consume(nonce) { if (consumed.has(nonce)) return false; consumed.add(nonce); return true; },
    },
    sessions: { async put(hash, value) { if (failStore) throw new Error("secret database credentials"); sessions.set(hash, value); }, async get(hash) { return sessions.get(hash); } },
  });
  const middleware = service.middleware({ authorize: ({ user }) => user.allowed });
  const server = createServer(async (request, response) => {
    await middleware(request, response, async () => {
      calls++;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.end(JSON.stringify({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/private/report?format=json`;
  const send = (headers: Record<string, string> = {}, method = "GET", body?: string) => fetch(url, { headers, method, body });
  const proof = async (): Promise<AuthenticationProof> => {
    const response = await send({ "Agent-ID": agentId });
    assert.equal(response.status, 401);
    const auth = (await response.json()).authentication;
    assert.equal(auth.transport, "resource");
    assert.equal(auth.challenge.agentId, agentId);
    return { ...auth.challenge, signature: `0x${"11".repeat(64)}` };
  };
  try {
    const discovery = await send();
    assert.equal(discovery.status, 401);
    assert.equal((await discovery.json()).authentication.challenge, undefined);
    assert.equal(challenges.size, 0);
    const malformed: Record<string, string>[] = [{ "Agent-ID": "bad" }, { "Agent-Signature": "0x1234" }, { "Agent-ID": "0x0000000000000000000000000000000000000000" }];
    for (const headers of malformed) {
      assert.equal((await send(headers)).status, 400);
    }
    const signed = await proof();
    const headers = sessionProofHeaders(signed);
    assert.equal((await send({ ...headers, "Agent-Session": "a".repeat(43) })).status, 400);
    assert.equal((await send({ ...headers, "Agent-Chain-ID": "31337junk" })).status, 400);
    for (const changed of [{ audience: "https://other.example" }, { chainId: 1 }, { agentId: implementation },
      { nonce: `0x${"22".repeat(32)}` }, { issuedAt: 99 }, { signature: "0x12" }]) {
      const response = await send(sessionProofHeaders({ ...signed, ...changed } as AuthenticationProof));
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("Agent-Session"), null);
      assert.equal(response.headers.get("WWW-Authenticate"), null, "bad proof must not trigger a signing loop");
    }
    signatureValid = false;
    assert.equal((await send(headers)).status, 401);
    signatureValid = true;
    assert.equal(calls, 0);
    const responses = await Promise.all([send(headers), send(headers)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
    assert.equal(calls, 1, "single-use challenge blocks concurrent replay");
    assert.equal(sessions.size, 1);
    const accepted = responses.find(r => r.status === 200)!;
    const token = accepted.headers.get("Agent-Session")!;
    assert(token);
    assert.equal(accepted.headers.get("Agent-Session-Expires-At"), "160");
    assert.equal((await send({ "Agent-Session": token, "Agent-ID": implementation })).status, 400);
    assert.equal((await send({ "Agent-Session": token })).status, 200);
    allowed = false;
    assert.equal((await send({ "Agent-Session": token })).status, 403);
    const denied = await send(sessionProofHeaders(await proof()));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Agent-Session"), null);
    assert.equal(sessions.size, 1, "permission denial must not persist a session");
    allowed = true; associated = false;
    assert.equal((await send(sessionProofHeaders(await proof()))).status, 403);
    associated = true; admitted = false;
    assert.equal((await send(sessionProofHeaders(await proof()))).status, 403);
    admitted = true;
    const postHeaders = sessionProofHeaders(await proof());
    const posted = await send(postHeaders, "POST", '{"operation":"compute"}');
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), { method: "POST", url: "/private/report?format=json", body: '{"operation":"compute"}' });
    const expires = sessionProofHeaders(await proof());
    now = 161;
    assert.equal((await send(expires)).status, 401);
    const renewed = await send({ "Agent-Session": token, "Agent-ID": agentId });
    assert.equal(renewed.status, 401);
    assert((await renewed.json()).authentication.challenge);
    const beforeOutage = sessionProofHeaders(await proof());
    failRpc = true;
    for (const auth of [{ "Agent-ID": agentId }, beforeOutage]) {
      const unavailable = await send(auth);
      assert.equal(unavailable.status, 503);
      assert(!((await unavailable.text()).includes("secret")));
    }
    failRpc = false; failStore = true;
    assert.equal((await send({ "Agent-ID": agentId })).status, 503);
    assert.equal((await send(beforeOutage)).status, 503);
    failStore = false;
    const duplicateStatus = await new Promise<number>(resolve => {
      const req = httpRequest(url, { headers: ["Agent-ID", agentId, "Agent-ID", implementation] }, response => {
        response.resume(); resolve(response.statusCode!);
      });
      req.end();
    });
    assert.equal(duplicateStatus, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
