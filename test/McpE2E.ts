import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import hre from "hardhat";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { concatHex, encodeFunctionData, keccak256, parseEther, toBytes, toHex, zeroAddress, type Address, type Hex } from "viem";
import { p256 } from "@noble/curves/nist.js";
import { createAgenticWorldMcp } from "../mcp/server.js";
import { startDemoService } from "../demo-service/server.js";
import { startDemoServiceB } from "../demo-service-b/server.js";
import { agentAccountAbi, encodeAgentExecution } from "../sdk/core.js";

// Real local contracts, SDK-backed HTTP services and MCP protocol. The hardware
// signer and wallet UI are replaced with explicit test fixtures; no user key is touched.
test("P-256 MCP lifecycle: browser creation, both services, policy, rotation, restart and revocation", {
  skip: process.platform !== "darwin" ? "macOS helper fixture; Windows protocol vectors are checked separately" : false,
  timeout: 60_000,
}, async () => {
  const connection = await hre.network.create();
  const { viem } = connection;
  const [owner] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  const entryPoint = await viem.deployContract("RealEntryPoint");
  const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
  const implementation = await factory.read.implementation() as Address;
  const target = await viem.deployContract("PolicyActionTarget");
  const data = encodeFunctionData({ abi: target.abi, functionName: "purchase", args: [keccak256(toBytes("mcp-e2e"))] });
  const rpc = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString();
    const input = JSON.parse(body);
    try {
      const result = await connection.provider.request({ method: input.method, params: input.params });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    } catch (error) {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, error: { code: -32000, message: String(error) } }));
    }
  });
  await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
  const rpcAddress = rpc.address();
  assert(rpcAddress && typeof rpcAddress !== "string");
  const temporary = await mkdtemp(join(tmpdir(), "agentic-mcp-e2e-"));
  const configPath = join(temporary, "config.json");
  const launcher = join(temporary, "signer");
  const fixture = fileURLToPath(new URL("../scripts/demo/LocalSignerFixture.mjs", import.meta.url));
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${fixture}" "$@"\n`);
  await chmod(launcher, 0o700);
  await writeFile(configPath, JSON.stringify({ rpcUrl: `http://127.0.0.1:${rpcAddress.port}`, chainId: 31337,
    factory: factory.address, implementation, signer: { kind: "secure-enclave", binaryPath: launcher, label: "test-key" } }));
  const serviceA = await startDemoService({ client, chainId: 31337, implementation, audience: "https://service-a.example", port: 0 });
  const serviceB = await startDemoServiceB({ client, chainId: 31337, implementation, audience: "https://service-b.example", port: 0 });
  let mcp!: Client;
  let server!: Awaited<ReturnType<typeof createAgenticWorldMcp>>;
  let browserAction: (url: string) => Promise<void>;
  let browserWork: Promise<void> | undefined;
  let portalUrl: string | undefined;
  const post = (base: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  const approve = async (url: string) => {
    const context = await (await fetch(`${url}/context`)).json();
    const intent = context.transaction ? context : await (await post(url, "/prepare", { owner: owner.account.address }, { origin: new URL(url).origin })).json();
    assert.equal(intent.transaction.from.toLowerCase(), owner.account.address.toLowerCase());
    const hash = await owner.sendTransaction({ to: intent.transaction.to, data: intent.transaction.data, value: 0n });
    const done = await post(url, "/complete", { hash }, { origin: new URL(url).origin });
    assert.equal(done.status, 200, await done.text());
  };
  async function connect() {
    server = await createAgenticWorldMcp(JSON.parse(await readFile(configPath, "utf8")), undefined, configPath, {
      openBrowser: async url => {
        browserWork = browserAction(url).catch(async error => {
          await post(url, "/cancel", {}, { origin: new URL(url).origin }).catch(() => {});
          throw error;
        });
        void browserWork.catch(() => {});
      },
    });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    mcp = new Client({ name: "lifecycle-test", version: "1" });
    await mcp.connect(local);
  }
  async function call(name: string, args: Record<string, unknown> = {}, expectError = false) {
    const response = await mcp.callTool({ name, arguments: args });
    const text = response.content?.[0];
    assert(text?.type === "text");
    const result = JSON.parse(text.text);
    assert.equal(response.isError === true, expectError, text.text);
    return result;
  }
  async function browserCall(name: string, args: Record<string, unknown>, action = approve) {
    browserAction = action;
    browserWork = undefined;
    const result = await call(name, args);
    assert(browserWork, "tool must open the approval browser");
    await browserWork;
    return result;
  }
  async function proof(base: string, agentId: Address) {
    const offered = await fetch(`${base}/private/report`);
    assert.equal(offered.status, 401);
    const offer = (await offered.json()).authentication;
    assert.equal(offer.scheme, "AgenticWorld");
    const challengeResponse = await post(base, offer.challengeEndpoint, { agentId });
    assert.equal(challengeResponse.status, 200);
    return call("agentic_session_proof", { challenge: await challengeResponse.json() });
  }
  async function session(base: string, agentId: Address) {
    const signed = await proof(base, agentId);
    const response = await post(base, "/agent/session", signed);
    assert.equal(response.status, 200, await response.text());
    const token = response.headers.get("agent-session");
    assert(token);
    return token;
  }
  const resource = (base: string, token: string) => fetch(`${base}/private/report`, { headers: { "Agent-Session": token } });
  try {
    await connect();
    assert.equal((await call("agentic_identity")).configured, false);
    browserAction = async url => {
      const page = await fetch(`${url}/events`);
      const reader = page.body!.getReader();
      await reader.read();
      await reader.cancel();
    };
    const closed = await call("agentic_create_identity", { alias: "Closed tab" }, true);
    assert.equal(closed.code, "FLOW_CANCELLED");
    assert.equal(closed.retrySafe, true);
    await browserWork;
    const created = await browserCall("agentic_create_identity", { alias: "Research" });
    assert.equal(created.status, "IDENTITY_CREATED");
    const agentId = created.agentId as Address;
    const second = await browserCall("agentic_create_identity", { alias: "Assistant" });
    assert.notEqual(second.agentId, agentId);
    assert.equal((await call("agentic_list_identities")).count, 2);
    await call("agentic_set_alias", { agentId, alias: "Research updated" });
    assert.equal((await call("agentic_revoke_authenticator", {}, true)).code, "AGENT_SELECTION_REQUIRED");

    // Both services reject otherwise valid proofs until the relevant user association exists.
    assert.equal((await post(serviceA.baseUrl, "/agent/session", await proof(serviceA.baseUrl, agentId))).status, 401);
    assert.equal((await post(serviceB.baseUrl, "/agent/session", await proof(serviceB.baseUrl, agentId))).status, 401);
    const enroll = await (await post(serviceA.baseUrl, "/user/enrollment-challenge", { agentId })).json();
    assert.equal((await post(serviceA.baseUrl, "/user/enroll", { agentId, nonce: enroll.nonce,
      signature: await owner.signMessage({ message: enroll.message }) })).status, 200);
    const registration = await (await post(serviceB.baseUrl, "/owner/challenge", { owner: owner.account.address })).json();
    assert.equal((await post(serviceB.baseUrl, "/owner/register", { owner: owner.account.address, nonce: registration.nonce,
      signature: await owner.signMessage({ message: registration.message }) })).status, 200);
    const aProof = await proof(serviceA.baseUrl, agentId);
    assert.equal((await post(serviceB.baseUrl, "/agent/session", aProof)).status, 401);
    const accepted = await post(serviceA.baseUrl, "/agent/session", aProof);
    assert.equal(accepted.status, 200);
    const aToken = accepted.headers.get("agent-session")!;
    assert.equal((await post(serviceA.baseUrl, "/agent/session", aProof)).status, 401);
    assert.equal((await resource(serviceA.baseUrl, aToken)).status, 403);
    assert.equal((await post(serviceA.baseUrl, "/admin/permission", { agentId, resource: "report", allowed: true },
      { "x-operator-token": serviceA.operatorToken })).status, 200);
    assert.equal((await resource(serviceA.baseUrl, aToken)).status, 200);
    const bToken = await session(serviceB.baseUrl, agentId);
    assert.equal((await resource(serviceB.baseUrl, bToken)).status, 200);
    assert.equal((await resource(serviceB.baseUrl, aToken)).status, 401);
    await post(serviceA.baseUrl, "/admin/permission", { agentId, resource: "report", allowed: false }, { "x-operator-token": serviceA.operatorToken });
    assert.equal((await resource(serviceA.baseUrl, aToken)).status, 403);

    await browserCall("agentic_portal", {}, async url => {
      portalUrl = url;
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /managedSection/);
      const listed = await (await fetch(`${url}api/identities`)).json();
      assert.equal(listed.count, 2);
      assert.equal((await fetch(`${url}main.js`)).status, 200);
      assert.equal((await post(url, "api/alias", { agentId, alias: "Portal alias" }, { origin: new URL(url).origin })).status, 200);
      assert.equal((await post(url, "api/close", {}, { origin: new URL(url).origin })).status, 200);
      portalUrl = undefined;
    });
    const rules = [{ target: target.address, selector: data.slice(0, 10), token: zeroAddress,
      maxValueWei: "0", maxAmount: "0", decision: "ALLOW" }];
    const policy = await browserCall("agentic_set_policy", { agentId, rules });
    assert.equal(policy.status, "CONFIRMED_ONCHAIN");
    assert.equal((await call("agentic_policy_check", { agentId, target: target.address, valueWei: "0", data })).decision, "ALLOW");
    await entryPoint.write.depositTo([agentId], { value: parseEther("0.01") });
    const unsigned = { sender: agentId, nonce: 0n, initCode: "0x" as Hex,
      callData: encodeAgentExecution(target.address, 0n, data),
      accountGasLimits: concatHex([toHex(1_000_000n, { size: 16 }), toHex(500_000n, { size: 16 })]),
      preVerificationGas: 100_000n,
      gasFees: concatHex([toHex(1_000_000_000n, { size: 16 }), toHex(2_000_000_000n, { size: 16 })]),
      paymasterAndData: "0x" as Hex, signature: "0x" as Hex };
    const signOperation = async (nonce: bigint) => {
      const op = { ...unsigned, nonce };
      const hash = await entryPoint.read.getUserOpHash([op]) as Hex;
      const secret = new Uint8Array(32); secret[31] = 1;
      return { ...op, signature: toHex(p256.sign(toBytes(hash), secret, { prehash: false }).toCompactRawBytes()) };
    };
    await entryPoint.write.handleOps([[await signOperation(0n)], owner.account.address]);
    assert.equal(await target.read.calls(), 1n);
    await browserCall("agentic_set_policy", { agentId, rules: [] });
    assert.equal((await call("agentic_policy_check", { agentId, target: target.address, valueWei: "0", data })).decision, "DENY");
    await entryPoint.write.handleOps([[await signOperation(1n)], owner.account.address]);
    assert.equal(await target.read.calls(), 1n, "new policy denies the next P-256 UserOperation");

    browserAction = async url => {
      const page = await fetch(`${url}/events`);
      const reader = page.body!.getReader();
      await reader.read();
      await reader.cancel();
    };
    assert.equal((await call("agentic_rotate_authenticator", { agentId, scheme: "p256" }, true)).code, "FLOW_CANCELLED");
    await browserWork;
    await session(serviceB.baseUrl, agentId);
    assert.equal((await browserCall("agentic_rotate_authenticator", { agentId, scheme: "p256" })).status, "CONFIRMED_ONCHAIN");
    await session(serviceB.baseUrl, agentId);
    await session(serviceB.baseUrl, second.agentId);
    await mcp.close(); await server.close();
    await connect();
    await session(serviceB.baseUrl, agentId);
    assert.equal((await call("agentic_list_identities")).identities.find((item: { agentId: string }) => item.agentId === agentId).alias, "Portal alias");
    assert.equal((await browserCall("agentic_revoke_authenticator", { agentId })).status, "CONFIRMED_ONCHAIN");
    const listed = await call("agentic_list_identities");
    assert.equal(listed.count, 2);
    assert.equal(listed.identities.find((item: { agentId: string }) => item.agentId === agentId).status, "REVOKED");
    const challenge = await (await post(serviceB.baseUrl, "/agent/challenge", { agentId })).json();
    assert.equal((await call("agentic_session_proof", { challenge }, true)).code, "AUTHENTICATOR_REVOKED");
    await session(serviceB.baseUrl, second.agentId);
    assert.equal(await client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticationRevoked" }), true);

    // A smart owner wallet sends an outer transaction to itself, not the factory
    // or agent. The actual trusted events and resulting account must still verify.
    const wallet = await viem.deployContract("OwnerWalletFixture");
    let creationHash!: Hex;
    const approveWrapped = async (url: string) => {
      const context = await (await fetch(`${url}/context`)).json();
      const intent = context.transaction ? context : await (await post(url, "/prepare", { owner: wallet.address }, { origin: new URL(url).origin })).json();
      assert.equal(intent.transaction.from.toLowerCase(), wallet.address.toLowerCase());
      const hash = await wallet.write.forward([intent.transaction.to, intent.transaction.data]);
      if (!context.transaction) creationHash = hash;
      const completed = await post(url, "/complete", { hash }, { origin: new URL(url).origin });
      assert.equal(completed.status, 200, await completed.text());
    };
    const wrapped = await browserCall("agentic_create_identity", { alias: "Smart wallet" }, approveWrapped);
    assert.equal(wrapped.status, "IDENTITY_CREATED");
    assert.equal(wrapped.owner.toLowerCase(), wallet.address.toLowerCase());
    assert.equal((await client.readContract({ address: wrapped.agentId, abi: agentAccountAbi, functionName: "entryPoint" })).toLowerCase(), entryPoint.address.toLowerCase());
    const wrappedPolicy = await browserCall("agentic_set_policy", { agentId: wrapped.agentId, rules }, approveWrapped);
    assert.equal(wrappedPolicy.status, "CONFIRMED_ONCHAIN");
    assert.equal((await call("agentic_create_identity", { transactionHash: wrappedPolicy.transactionHash }, true)).code,
      "CREATION_EVENT_MISSING", "a successful unrelated receipt must not recover an identity");

    // Simulate the old MCP losing confirmation before saving the identity.
    await mcp.close(); await server.close();
    const lost = JSON.parse(await readFile(configPath, "utf8"));
    lost.agentIds = lost.agentIds.filter((id: string) => id.toLowerCase() !== wrapped.agentId.toLowerCase());
    lost.agentId = agentId;
    delete lost.aliases[wrapped.agentId.toLowerCase()];
    await writeFile(configPath, JSON.stringify(lost));
    await connect();
    browserAction = async () => { throw new Error("Recovery must not open a wallet or send a transaction"); };
    const recovered = await call("agentic_create_identity", { transactionHash: creationHash, alias: "Recovered" });
    assert.equal(recovered.status, "IDENTITY_RECOVERED");
    assert.equal(recovered.agentId, wrapped.agentId);
    assert.equal((await call("agentic_list_identities")).count, 3);
    assert.equal((await call("agentic_create_identity", { transactionHash: creationHash })).agentId, wrapped.agentId);
    assert.equal((await call("agentic_list_identities")).count, 3, "recovery is idempotent");
    assert.equal((await browserCall("agentic_rotate_authenticator", { agentId: wrapped.agentId, scheme: "p256" }, approveWrapped)).status, "CONFIRMED_ONCHAIN");
    assert.equal((await browserCall("agentic_revoke_authenticator", { agentId: wrapped.agentId }, approveWrapped)).status, "CONFIRMED_ONCHAIN");
  } finally {
    if (portalUrl) await post(portalUrl, "api/close", {}, { origin: new URL(portalUrl).origin }).catch(() => {});
    await mcp?.close(); await server?.close();
    await Promise.all([serviceA.close(), serviceB.close()]);
    rpc.closeAllConnections();
    await new Promise<void>(resolve => rpc.close(() => resolve()));
    await connection.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
