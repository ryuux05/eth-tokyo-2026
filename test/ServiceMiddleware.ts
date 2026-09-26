import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import type { Hex, PublicClient } from "viem";
import { AgenticWorld, type AgenticRequest, type Session } from "../sdk/service.js";

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
  const middleware = service.middleware({ realm: 'Reports "private"', challengeEndpoint: "/auth/challenge", sessionEndpoint: "/auth/session",
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
        challengeEndpoint: "/auth/challenge", sessionEndpoint: "/auth/session" });
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
    for (const challengeEndpoint of ["https://elsewhere.example/challenge", "//elsewhere.example", "/\\evil", "/bad\r\nheader"]) {
      assert.throws(() => service.middleware({ challengeEndpoint, authorize: () => true }), /same-origin/);
    }
    assert.throws(() => service.middleware({ realm: "bad\r\nheader", authorize: () => true }), /realm/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
