import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeDeployData, http, keccak256, parseAbi, type Abi, type Address, type Hex } from "viem";

const root = fileURLToPath(new URL("../", import.meta.url));
const chainId = 11155111;
const entryPoint = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address;
const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ transport: http(rpcUrl) });
const artifact = JSON.parse(await readFile(resolve(root, "artifacts/contracts/AgentAccountFactory.sol/AgentAccountFactory.json"), "utf8")) as {
  abi: Abi; bytecode: Hex;
};
const deployData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [entryPoint] });
const page = await readFile(resolve(root, "scripts/deploy-sepolia-page.html"), "utf8");
const token = randomBytes(24).toString("hex");
const scriptNonce = randomBytes(16).toString("base64");
const p256Probe = "0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023"
  + "0000000000000000000000000000000000000000000000000000000000000005"
  + "0000000000000000000000000000000000000000000000000000000000000001"
  + "a71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957"
  + "5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b" as Hex;
const addressAbi = parseAbi([
  "function implementation() view returns (address)",
  "function validator() view returns (address)",
  "function policyHook() view returns (address)",
]);
const implementationAbi = parseAbi([
  "function entryPoint() view returns (address)",
  "function factory() view returns (address)",
]);

if (await client.getChainId() !== chainId) throw new Error("Sepolia RPC returned the wrong chain ID");
if ((await client.getBytecode({ address: entryPoint })) === undefined) throw new Error("EntryPoint v0.8 is missing on this RPC");
if ((await client.call({ to: "0x0000000000000000000000000000000000000100", data: p256Probe })).data !== `0x${"0".repeat(63)}1`)
  throw new Error("Sepolia RPC does not support EIP-7951 P-256 verification");
const latestBlock = await client.getBlockNumber();
const checkpoint = await client.getBlock({ blockNumber: latestBlock > 10n ? latestBlock - 10n : latestBlock });
if (!checkpoint.hash) throw new Error("Sepolia RPC returned no block hash");

let base = "";
let submittedHash: Hex | undefined;
let submittedOwner: Address | undefined;
let verified = false;
let cancelled = false;
const server = createServer(async (request, response) => {
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
    response.end(JSON.stringify(value));
  };
  if (request.headers.host !== base.slice(7) || !request.url?.startsWith(`/deploy/${token}`)) {
    send(404, { error: "Not found" }); return;
  }
  if (request.url === `/deploy/${token}` && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    response.end(page.replace('<script type="module">', `<script type="module" nonce="${scriptNonce}">`));
    return;
  }
  if (request.url === `/deploy/${token}/context` && request.method === "GET") {
    send(200, { chainId, entryPoint, deployData, initCodeHash: keccak256(deployData),
      checkpointNumber: checkpoint.number.toString(), checkpointHash: checkpoint.hash, submittedHash, submittedOwner });
    return;
  }
  if (request.url === `/deploy/${token}/cancel` && request.method === "POST" && request.headers.origin === base) {
    if (submittedHash || verified) { send(409, { error: "A transaction was submitted. Closing this page cannot cancel it; check its hash before retrying." }); return; }
    cancelled = true;
    response.once("finish", () => setTimeout(() => {
      clearTimeout(timer);
      server.closeAllConnections(); server.close();
      process.stdout.write("SEPOLIA_DEPLOYMENT_CANCELLED No transaction was submitted through this page.\n");
    }, 20));
    send(200, { cancelled: true });
    return;
  }
  if (request.url !== `/deploy/${token}/complete` || request.method !== "POST" || request.headers.origin !== base ||
      !request.headers["content-type"]?.startsWith("application/json")) { send(403, { error: "Request rejected" }); return; }
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1024) { send(413, { error: "Request too large" }); return; }
  }
  try {
    const input = JSON.parse(body) as { hash?: string; owner?: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.hash ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(input.owner ?? "")) {
      send(400, { error: "Invalid transaction hash or wallet address" }); return;
    }
    const hash = input.hash as Hex;
    const owner = input.owner as Address;
    if (submittedHash && (submittedHash !== hash || submittedOwner?.toLowerCase() !== owner.toLowerCase())) {
      send(409, { error: "A different deployment was already submitted in this session" }); return;
    }
    submittedHash = hash;
    submittedOwner = owner;
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 600_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment transaction failed");
    const tx = await client.getTransaction({ hash });
    if (tx.from.toLowerCase() !== owner.toLowerCase() || tx.to !== null || tx.input.toLowerCase() !== deployData.toLowerCase() || tx.value !== 0n)
      throw new Error("Confirmed transaction does not match this deployment");
    const factory = receipt.contractAddress;
    const [factoryCode, implementation, validator, policyHook] = await Promise.all([
      client.getBytecode({ address: factory }),
      client.readContract({ address: factory, abi: addressAbi, functionName: "implementation" }),
      client.readContract({ address: factory, abi: addressAbi, functionName: "validator" }),
      client.readContract({ address: factory, abi: addressAbi, functionName: "policyHook" }),
    ]);
    if (!factoryCode || factoryCode === "0x") throw new Error("Factory bytecode missing after deployment");
    const [implementationCode, validatorCode, policyHookCode, pinnedEntryPoint, pinnedFactory] = await Promise.all([
      client.getBytecode({ address: implementation }), client.getBytecode({ address: validator }),
      client.getBytecode({ address: policyHook }),
      client.readContract({ address: implementation, abi: implementationAbi, functionName: "entryPoint" }),
      client.readContract({ address: implementation, abi: implementationAbi, functionName: "factory" }),
    ]);
    if (!implementationCode || !validatorCode || !policyHookCode ||
        pinnedEntryPoint.toLowerCase() !== entryPoint.toLowerCase() || pinnedFactory.toLowerCase() !== factory.toLowerCase())
      throw new Error("Deployed account stack failed verification");
    verified = true;
    const result = { chainId, hash, blockNumber: receipt.blockNumber.toString(), factory, implementation, validator, policyHook, entryPoint };
    process.stdout.write(`SEPOLIA_DEPLOYMENT ${JSON.stringify(result)}\n`);
    send(200, result);
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : "Deployment verification failed" });
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not bind local deployment page");
base = `http://127.0.0.1:${address.port}`;
process.stdout.write(`SEPOLIA_DEPLOYMENT_URL ${base}/deploy/${token}\n`);
process.stdout.write("Review and sign in your wallet. This local page will verify the transaction independently after confirmation.\n");
const timer = setTimeout(() => {
  if (!verified && !cancelled) process.stderr.write("Deployment page expired. If a transaction was submitted, check its hash before retrying.\n");
  server.closeAllConnections(); server.close();
}, 30 * 60_000);
process.once("SIGINT", () => { clearTimeout(timer); server.closeAllConnections(); server.close(); });
