import { concatHex, decodeEventLog, encodeFunctionData, erc20Abi, getAddress, hashTypedData, http, createClient,
  isAddress, keccak256, parseAbi, parseUnits, toHex, type Address, type Hex, type PublicClient } from "viem";
import { getUserOperationHash, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { encodeAgentExecution, type OwnerApproval } from "./execution.js";
import { agentPolicyAbi, ownerActionTypedData, Decision } from "./policy.js";
import { isExpectedAgentClone } from "./core.js";

// Only our own fixed messages may cross the MCP boundary. Provider exceptions
// can contain an RPC URL/API key and must never be copied into the journal.
class PaymentError extends Error {}

export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
export const ENTRYPOINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address;
export const MAX_PAYMENT_GAS_WEI = 5_000_000_000_000_000n; // 0.005 ETH absolute local signer ceiling.
export const executionAccountAbi = parseAbi([
  "function executionVersion() view returns (uint256)", "function owner() view returns (address)",
  "function entryPoint() view returns (address)", "function authenticationRevoked() view returns (bool)",
]);
export const paymentEntryPointAbi = parseAbi([
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
]);
export type PaymentOperation = UserOperation<"0.8">;
export type ExecutionSigningRequest = {
  kind: "AgentExecution"; chainId: number; entryPoint: Address; validUntil: number;
  userOperation: { sender: Address; nonce: Hex; callData: Hex; accountGasLimits: Hex; preVerificationGas: Hex; gasFees: Hex };
};
export type PaymentIntent = { agentId: Address; recipient: Address; amount: string };
export type PaymentRecord = PaymentIntent & { requestId: string; intentHash: Hex; status: "PREPARING" | "SIGNED" | "SUBMITTED" | "UNKNOWN" | "CONFIRMED" | "REVERTED" | "FAILED";
  userOpHash?: Hex; operation?: PaymentOperation; validUntil?: number; transactionHash?: Hex; error?: string };
export type PaymentJournal = { get(id: string): Promise<PaymentRecord | undefined>; put(record: PaymentRecord): Promise<void> };
export type BundlerRpc = { request(method: string, params: unknown[]): Promise<any> };

/** Uses standard bundler RPC plus Pimlico's fee quote. No sponsorship or provider-supplied signing digest. */
export function pimlicoBundler(url: string): BundlerRpc {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)))
    throw new PaymentError("Bundler must use HTTPS (or explicit local testing RPC)");
  const client = createClient({ transport: http(url, { retryCount: 0, timeout: 15000, fetchOptions: { redirect: "error" } }) });
  return { async request(method, params) {
    try { return await client.request({ method, params } as any); }
    catch { throw new PaymentError(`Bundler ${method} failed; inspect local provider diagnostics (RPC credentials are redacted)`); }
  } };
}

export function executionTypedData(chainId: number, agentId: Address, userOpHash: Hex, validUntil: number) {
  return { domain: { name: "Agentic World AgentAccount", version: "1", chainId, verifyingContract: agentId },
    types: { AgentExecution: [{ name: "userOpHash", type: "bytes32" }, { name: "validUntil", type: "uint48" }] },
    primaryType: "AgentExecution", message: { userOpHash, validUntil } } as const;
}
export function executionSigningRequest(chainId: number, entryPoint: Address, operation: PaymentOperation, validUntil: number): ExecutionSigningRequest {
  const packed = toPackedUserOperation(operation);
  if (packed.initCode !== "0x" || packed.paymasterAndData !== "0x") throw new PaymentError("Counterfactual accounts/paymasters are not supported by payment signing");
  return { kind: "AgentExecution", chainId, entryPoint, validUntil, userOperation: { sender: operation.sender,
    nonce: toHex(operation.nonce, { size: 32 }), callData: operation.callData, accountGasLimits: packed.accountGasLimits,
    preVerificationGas: toHex(operation.preVerificationGas, { size: 32 }), gasFees: packed.gasFees } };
}
export function executionDigest(chainId: number, entryPoint: Address, operation: PaymentOperation, validUntil: number): Hex {
  const hash = getUserOperationHash({ chainId, entryPointAddress: entryPoint, entryPointVersion: "0.8", userOperation: operation });
  return hashTypedData(executionTypedData(chainId, operation.sender, hash, validUntil));
}
export function wrapExecutionSignature(validUntil: number, signature: Hex): Hex {
  if (!Number.isSafeInteger(validUntil) || validUntil <= 0 || validUntil >= 2 ** 48 || !/^0x[0-9a-fA-F]{128}$/.test(signature))
    throw new PaymentError("Invalid P-256 execution signature");
  return concatHex([toHex(validUntil, { size: 6 }), signature]);
}
function rpcOperation(op: PaymentOperation) {
  return Object.fromEntries(Object.entries(op).map(([key, value]) => [key, typeof value === "bigint" ? toHex(value) : value]));
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new PaymentError("Invalid bundler quantity");
  return BigInt(value);
}
export function paymentAmount(amount: string): bigint {
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,6})?$/.test(amount)) throw new PaymentError("Use a positive USDC amount with at most 6 decimals");
  const units = parseUnits(amount, 6);
  if (units <= 0n) throw new PaymentError("Payment amount must be positive");
  return units;
}

/** The caller serializes execution and supplies a durable journal (MCP uses an exclusive disk lock). */
export function createPaymentExecutor(config: {
  client: PublicClient; chainId: number; implementation: Address; token?: Address; entryPoint?: Address; bundler: BundlerRpc;
  journal: PaymentJournal; maxGasCostWei?: bigint; signal?: AbortSignal;
  sign: (request: ExecutionSigningRequest) => Promise<Hex>;
  approve: (typedData: ReturnType<typeof ownerActionTypedData>, intent: PaymentIntent) => Promise<Hex>;
  now?: () => number;
}) {
  const { client, bundler, journal } = config;
  const token = config.token ?? SEPOLIA_USDC;
  const entryPoint = config.entryPoint ?? ENTRYPOINT_V08;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const gasCap = config.maxGasCostWei ?? MAX_PAYMENT_GAS_WEI;
  const checkCancelled = () => { if (config.signal?.aborted) throw new PaymentError("PAYMENT_CANCELLED: stopped before submission"); };
  if (gasCap <= 0n || gasCap > MAX_PAYMENT_GAS_WEI) throw new PaymentError("Invalid gas budget");
  async function state(intent: PaymentIntent) {
    const amount = paymentAmount(intent.amount);
    if (![intent.agentId, intent.recipient].every(address => isAddress(address)) || intent.agentId.toLowerCase() === intent.recipient.toLowerCase() || BigInt(intent.recipient) === 0n)
      throw new PaymentError("Invalid agent or payment recipient");
    if (await client.getChainId() !== config.chainId) throw new PaymentError("Chain mismatch");
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const code = await client.getBytecode({ address: intent.agentId, blockNumber });
    if (!isExpectedAgentClone(code, config.implementation)) throw new PaymentError("Untrusted account implementation");
    let version: bigint;
    try { version = await client.readContract({ address: intent.agentId, abi: executionAccountAbi, functionName: "executionVersion", blockNumber }); }
    catch { throw new PaymentError("EXECUTION_UPGRADE_REQUIRED: legacy accounts are authentication/preview only. Create an account from the newly verified execution deployment."); }
    if (version !== 1n) throw new PaymentError("Unsupported execution version");
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(intent.recipient), amount] });
    const [owner, ep, revoked, decision, policyHash, policyRevision, approvalNonce, balance, decimals] = await Promise.all([
      client.readContract({ address: intent.agentId, abi: executionAccountAbi, functionName: "owner", blockNumber }),
      client.readContract({ address: intent.agentId, abi: executionAccountAbi, functionName: "entryPoint", blockNumber }),
      client.readContract({ address: intent.agentId, abi: executionAccountAbi, functionName: "authenticationRevoked", blockNumber }),
      client.readContract({ address: intent.agentId, abi: agentPolicyAbi, functionName: "evaluateAction", args: [token, 0n, data], blockNumber }),
      client.readContract({ address: intent.agentId, abi: agentPolicyAbi, functionName: "policyHash", blockNumber }),
      client.readContract({ address: intent.agentId, abi: agentPolicyAbi, functionName: "policyRevision", blockNumber }),
      client.readContract({ address: intent.agentId, abi: agentPolicyAbi, functionName: "ownerApprovalNonce", blockNumber }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [intent.agentId], blockNumber }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber }),
    ]);
    if (ep.toLowerCase() !== entryPoint.toLowerCase() || revoked || decimals !== 6) throw new PaymentError("Invalid EntryPoint, revoked authenticator, or unsupported token decimals");
    if (decision === Decision.DENY) throw new PaymentError("POLICY_DENIED: this transfer is not permitted");
    if (balance < amount) throw new PaymentError("INSUFFICIENT_USDC: fund the agent account before paying");
    return { owner, decision, policyHash, policyRevision, approvalNonce, data, amount };
  }
  async function status(requestId: string): Promise<PaymentRecord> {
    const record = await journal.get(requestId);
    if (!record) throw new PaymentError("Unknown payment request ID");
    if (!record.userOpHash || !record.operation || ["CONFIRMED", "REVERTED"].includes(record.status)) return record;
    if (await client.getChainId() !== config.chainId) throw new PaymentError("Chain mismatch while checking payment");
    const result = await bundler.request("eth_getUserOperationReceipt", [record.userOpHash]);
    if (!result) return record;
    const tx = result.receipt?.transactionHash;
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new PaymentError("Invalid bundler receipt");
    // Never trust bundler success alone: verify the exact operation and transfer on our independent chain RPC.
    const receipt = await client.getTransactionReceipt({ hash: tx as Hex });
    let previousEvent = -1;
    for (let i = 0; i < receipt.logs.length; i++) {
      const log = receipt.logs[i];
      if (log.address.toLowerCase() !== entryPoint.toLowerCase()) continue;
      let event;
      try { event = decodeEventLog({ abi: paymentEntryPointAbi, data: log.data, topics: log.topics }); } catch { continue; }
      if (event.eventName !== "UserOperationEvent") continue;
      if (event.args.userOpHash !== record.userOpHash) { previousEvent = i; continue; }
      if (event.args.sender.toLowerCase() !== record.agentId.toLowerCase() || event.args.nonce !== record.operation.nonce)
        throw new PaymentError("UserOperation receipt mismatch");
      const transferred = receipt.logs.slice(previousEvent + 1, i).some(item => {
        if (item.address.toLowerCase() !== token.toLowerCase()) return false;
        try {
          const transfer = decodeEventLog({ abi: erc20Abi, data: item.data, topics: item.topics });
          return transfer.eventName === "Transfer" && transfer.args.from.toLowerCase() === record.agentId.toLowerCase() &&
            transfer.args.to.toLowerCase() === record.recipient.toLowerCase() && transfer.args.value === paymentAmount(record.amount);
        } catch { return false; }
      });
      const success = receipt.status === "success" && event.args.success;
      if (success && !transferred) throw new PaymentError("Operation succeeded without the expected USDC transfer; not reporting payment success");
      const updated: PaymentRecord = { ...record, status: success ? "CONFIRMED" : "REVERTED", transactionHash: receipt.transactionHash,
        error: success ? undefined : "UserOperation reverted; no transfer completed." };
      await journal.put(updated);
      return updated;
    }
    throw new PaymentError("Receipt has no matching EntryPoint operation");
  }
  async function pay(requestId: string, intent: PaymentIntent): Promise<PaymentRecord> {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw new PaymentError("Use a stable requestId (8–80 letters, digits, hyphens or underscores) for retry safety");
    const intentHash = keccak256(new TextEncoder().encode(JSON.stringify([config.chainId, token.toLowerCase(), intent.agentId.toLowerCase(), intent.recipient.toLowerCase(), paymentAmount(intent.amount).toString()])));
    const existing = await journal.get(requestId);
    if (existing) {
      if (existing.intentHash !== intentHash) throw new PaymentError("Request ID was already used for a different payment");
      return status(requestId); // Never automatically send or sign again after an ambiguous submission.
    }
    let record: PaymentRecord = { ...intent, requestId, intentHash, status: "PREPARING" };
    await journal.put(record);
    try {
      checkCancelled();
      const initial = await state(intent);
      const supported = await bundler.request("eth_supportedEntryPoints", []);
      if (!Array.isArray(supported) || !supported.some(value => typeof value === "string" && value.toLowerCase() === entryPoint.toLowerCase())) throw new PaymentError("Bundler does not support this EntryPoint v0.8 deployment");
      let approval: OwnerApproval | undefined;
      if (initial.decision === Decision.REQUIRE_OWNER_SIGNATURE) {
        const deadline = BigInt(now() + 300);
        const typedData = ownerActionTypedData({ agent: intent.agentId, chainId: config.chainId, target: token, value: 0n,
          data: initial.data, policyHash: initial.policyHash, policyRevision: initial.policyRevision, nonce: initial.approvalNonce, deadline });
        approval = { nonce: initial.approvalNonce, deadline, signature: await config.approve(typedData, intent) };
        if (!await client.verifyTypedData({ address: initial.owner, ...typedData, signature: approval.signature })) throw new PaymentError("Owner approval is invalid");
      }
      const latest = await state(intent);
      if (latest.policyHash !== initial.policyHash || latest.policyRevision !== initial.policyRevision || latest.approvalNonce !== initial.approvalNonce) throw new PaymentError("Policy/approval state changed; obtain a fresh payment approval");
      const price = (await bundler.request("pimlico_getUserOperationGasPrice", [])).standard;
      const validUntil = Math.min(now() + 180, approval ? Number(approval.deadline) : now() + 180);
      if (validUntil <= now() + 15) throw new PaymentError("Owner approval is too close to expiry; request fresh approval");
      const operation: PaymentOperation = { sender: intent.agentId,
        nonce: await client.readContract({ address: entryPoint, abi: paymentEntryPointAbi, functionName: "getNonce", args: [intent.agentId, 0n] }),
        callData: encodeAgentExecution(token, 0n, initial.data, approval),
        callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
        maxFeePerGas: quantity(price.maxFeePerGas), maxPriorityFeePerGas: quantity(price.maxPriorityFeePerGas),
        signature: wrapExecutionSignature(validUntil, `0x${"11".repeat(64)}`) };
      if (operation.maxPriorityFeePerGas > operation.maxFeePerGas || operation.maxFeePerGas > 100_000_000_000n) throw new PaymentError("Invalid or excessive fee quote");
      const gas = await bundler.request("eth_estimateUserOperationGas", [rpcOperation(operation), entryPoint]);
      operation.callGasLimit = quantity(gas.callGasLimit) * 120n / 100n;
      operation.verificationGasLimit = quantity(gas.verificationGasLimit) * 120n / 100n;
      operation.preVerificationGas = quantity(gas.preVerificationGas) * 120n / 100n;
      const gasUnits = operation.callGasLimit + operation.verificationGasLimit + operation.preVerificationGas;
      if (operation.callGasLimit === 0n || operation.verificationGasLimit === 0n || gasUnits > 5_000_000n || gasUnits * operation.maxFeePerGas > gasCap) throw new PaymentError("Payment gas budget exceeded");
      const [eth, deposit] = await Promise.all([client.getBalance({ address: intent.agentId }), client.readContract({ address: entryPoint, abi: paymentEntryPointAbi, functionName: "balanceOf", args: [intent.agentId] })]);
      if (eth + deposit < gasUnits * operation.maxFeePerGas) throw new PaymentError("INSUFFICIENT_GAS: fund the agent with ETH or its EntryPoint deposit");
      checkCancelled();
      operation.signature = wrapExecutionSignature(validUntil, await config.sign(executionSigningRequest(config.chainId, entryPoint, operation, validUntil)));
      const userOpHash = getUserOperationHash({ chainId: config.chainId, entryPointAddress: entryPoint, entryPointVersion: "0.8", userOperation: operation });
      record = { ...record, status: "SIGNED", operation, validUntil, userOpHash };
      await journal.put(record); // Persist before first broadcast; a crash must not cause duplicate spending.
      checkCancelled();
      try {
        const returnedHash = await bundler.request("eth_sendUserOperation", [rpcOperation(operation), entryPoint]);
        if (returnedHash !== userOpHash) throw new PaymentError("Bundler returned a mismatched operation hash");
        record = { ...record, status: "SUBMITTED" };
      } catch { record = { ...record, status: "UNKNOWN", error: "Submission outcome unknown. Check this requestId/userOpHash; do not create a duplicate payment." }; }
      await journal.put(record);
      return record;
    } catch (error) {
      record = { ...record, status: record.userOpHash ? "UNKNOWN" : "FAILED", error: error instanceof PaymentError ? error.message : "Payment preparation failed or approval was cancelled. No new submission was attempted; inspect local diagnostics." };
      await journal.put(record);
      return record;
    }
  }
  return { pay, status };
}
