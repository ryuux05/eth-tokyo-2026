import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import hre from "hardhat";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { p256 } from "@noble/curves/nist.js";
import { parseEther, toHex, type Address, type Hex } from "viem";
import { getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { createAgenticWorldMcp } from "../mcp/server.js";
import { ENTRYPOINT_V08, SEPOLIA_USDC, type PaymentOperation } from "../sdk/payments.js";

test("MCP payment tools: owner policy transaction, hardware-protocol signing, bundler submission and verified transfer", {
  skip: process.platform !== "darwin" ? "macOS software test fixture; no hardware keys accessed" : false,
  timeout: 60_000,
}, async () => {
  const network = await hre.network.create();
  const { viem } = network;
  const [owner, recipient] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  const epSource = await viem.deployContract("RealEntryPoint");
  const tokenSource = await viem.deployContract("PolicyDemoUSDC");
  for (const [from, to] of [[epSource.address, ENTRYPOINT_V08], [tokenSource.address, SEPOLIA_USDC]] as const)
    await network.provider.request({ method: "hardhat_setCode", params: [to, await client.getBytecode({ address: from })] });
  const ep = await viem.getContractAt("RealEntryPoint", ENTRYPOINT_V08);
  const token = await viem.getContractAt("PolicyDemoUSDC", SEPOLIA_USDC);
  const factory = await viem.deployContract("AgentAccountFactory", [ENTRYPOINT_V08]);
  const secret = new Uint8Array(32); secret[31] = 1;
  const pub = p256.getPublicKey(secret, false);
  const salt = toHex(892n, { size: 32 });
  const agentId = await factory.read.predictAgent([owner.account.address, salt]) as Address;
  await factory.write.createAgentP256([toHex(pub.slice(1, 33)), toHex(pub.slice(33)), salt]);
  await token.write.mint([agentId, 50_000_000n]);
  await owner.sendTransaction({ to: agentId, value: parseEther("0.1") });
  const receipts = new Map<string, Hex>();
  let sends = 0, approvals = 0;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const { id, method, params } = JSON.parse(body);
    try {
      let result;
      if (method === "eth_supportedEntryPoints") result = [ENTRYPOINT_V08];
      else if (method === "pimlico_getUserOperationGasPrice") result = { standard: { maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: toHex(1_000_000_000n) } };
      else if (method === "eth_estimateUserOperationGas") result = { callGasLimit: toHex(400_000n), verificationGasLimit: toHex(400_000n), preVerificationGas: toHex(50_000n) };
      else if (method === "eth_getUserOperationReceipt") result = receipts.has(params[0]) ? { receipt: { transactionHash: receipts.get(params[0]) } } : null;
      else if (method === "eth_sendUserOperation") {
        sends++;
        const op = { ...params[0] } as PaymentOperation;
        for (const field of ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) op[field] = BigInt(op[field]);
        result = getUserOperationHash({ chainId: 31337, entryPointAddress: ENTRYPOINT_V08, entryPointVersion: "0.8", userOperation: op });
        const tx = await ep.write.handleOps([[toPackedUserOperation(op)], owner.account.address]);
        await client.waitForTransactionReceipt({ hash: tx }); receipts.set(result, tx);
      } else result = await network.provider.request({ method, params });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch { res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Test RPC failed" } })); }
  });
  await new Promise<void>(done => rpc.listen(0, "127.0.0.1", done));
  const addr = rpc.address(); assert(addr && typeof addr !== "string");
  const temporary = await mkdtemp(join(tmpdir(), "agentic-mcp-payments-"));
  const configPath = join(temporary, "config.json");
  const launcher = join(temporary, "signer");
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${resolve("scripts/demo/LocalSignerFixture.mjs")}" "$@"\n`);
  await chmod(launcher, 0o700);
  const rpcUrl = `http://127.0.0.1:${addr.port}`;
  const config = { rpcUrl, chainId: 31337, agentId, factory: factory.address, implementation: await factory.read.implementation(),
    execution: { bundlerRpcUrl: rpcUrl }, signer: { kind: "secure-enclave", binaryPath: launcher, label: "test-key" } };
  await writeFile(configPath, JSON.stringify(config));
  let browserWork: Promise<void> | undefined;
  const server = await createAgenticWorldMcp(config, undefined, configPath, { openBrowser: async url => {
    browserWork = (async () => {
      const context = await (await fetch(`${url}/context`)).json();
      let body;
      if (context.typedData) {
        approvals++;
        body = { signature: await owner.signTypedData(context.typedData) };
      } else {
        body = { hash: await owner.sendTransaction({ to: context.transaction.to, data: context.transaction.data, value: BigInt(context.transaction.value) }) };
      }
      const reply = await fetch(`${url}/complete`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(reply.status, 200, await reply.text());
    })();
    void browserWork.catch(() => {});
  } });
  const mcp = new Client({ name: "payments-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await mcp.connect(b);
    const call = async (name: string, args: object) => {
      const result = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      assert(!result.isError, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    await call("agentic_set_transfer_policy", { agentId, rules: [
      { recipient: recipient.account.address, maxUsdc: "5", decision: "ALLOW" },
      { recipient: recipient.account.address, maxUsdc: "20", decision: "REQUIRE_OWNER_SIGNATURE" },
    ] });
    await browserWork;
    for (const [requestId, amount] of [["mcp-pay-0001", "5"], ["mcp-pay-0002", "20"]]) {
      const result = await call("agentic_pay_usdc", { agentId, recipient: recipient.account.address, amount, requestId });
      assert.equal(result.status, "SUBMITTED", JSON.stringify(result)); assert.equal(result.paid, false);
      assert.equal(result.operation, undefined, "signed operation stays private in local journal");
      assert.equal((await call("agentic_payment_status", { requestId })).paid, true);
    }
    await browserWork;
    assert.equal(approvals, 1); assert.equal(sends, 2);
    assert.equal(await token.read.balanceOf([recipient.account.address]), 25_000_000n);
    await call("agentic_pay_usdc", { agentId, recipient: recipient.account.address, amount: "5", requestId: "mcp-pay-0001" });
    assert.equal(sends, 2);
    assert.match(await readFile(`${configPath}.payments.json`, "utf8"), /CONFIRMED/);
    const shop = await viem.deployContract("PolicyDemoService");
    await call("agentic_set_policy", { agentId, rules: [
      { target: shop.address, selector: "0x95f43b71", token: SEPOLIA_USDC, maxValueWei: "0", maxAmount: "1000000", decision: "ALLOW" },
      { target: shop.address, selector: "0x95f43b71", token: SEPOLIA_USDC, maxValueWei: "0", maxAmount: "2000000", decision: "REQUIRE_OWNER_SIGNATURE" },
    ] });
    await browserWork;
    const setup = await call("agentic_enable_compute_allowance", { agentId });
    await browserWork;
    assert.equal(setup.status, "CONFIRMED_ONCHAIN");
    for (const amount of ["1", "2"]) {
      const allowanceId = `mcp-allowance-${amount}`;
      const purchaseId = `mcp-purchase-${amount}`;
      const allowance = await call("agentic_approve_compute_allowance", { agentId, target: shop.address, amount, requestId: allowanceId });
      await browserWork;
      assert.equal(allowance.status, "SUBMITTED", JSON.stringify(allowance));
      const confirmedAllowance = await call("agentic_payment_status", { requestId: allowanceId });
      assert.equal(confirmedAllowance.allowanceConfirmed, true);
      assert.equal(confirmedAllowance.paid, false);
      const purchase = await call("agentic_purchase_compute", { agentId, target: shop.address, amount, requestId: purchaseId });
      await browserWork;
      assert.equal(purchase.status, "SUBMITTED", JSON.stringify(purchase));
      const receipt = await call("agentic_payment_status", { requestId: purchaseId });
      assert.equal(receipt.purchaseConfirmed, true);
      assert.equal(receipt.paid, true);
    }
    assert.equal(await token.read.balanceOf([shop.address]), 3_000_000n);
  } finally {
    await mcp.close(); await server.close(); rpc.closeAllConnections(); await new Promise<void>(done => rpc.close(() => done()));
    await rm(temporary, { recursive: true, force: true });
  }
});
