import { randomBytes } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { concatHex, createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, isAddress, keccak256, parseAbiItem, zeroAddress, type AbiEvent, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { createAgentSdk } from "../sdk/agent.js";
import { isExpectedAgentClone, agentAccountAbi, agentAccountFactoryAbi, agentPolicyAbi, encodePolicy, Decision,
  SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT, trustedFactory, trustedImplementation, resolveSepoliaAgentDeployment, type PolicyRule } from "../sdk/core.js";
import { assertAudience, sessionProofHeaders, type AuthenticationChallenge } from "../sdk/core.js";
import { ensureSignerPublicKey, signLocalChallenge, signLocalExecution, signerPublicKey } from "./local-signer.js";
import { createPaymentExecutor, pimlicoBundler, SEPOLIA_USDC, executionAccountAbi, paymentAmount, type PaymentRecord } from "../sdk/payments.js";
import { decodePolicy, encodeTransferPolicy } from "../sdk/policy.js";
import { withPaymentJournal } from "./payment-journal.js";
import { approvePayment } from "./payment-approval.js";
import { runCreationFlow, type CreationIntent } from "./creation-flow.js";
import { runOwnerActionFlow, type OwnerActionIntent } from "./owner-action-flow.js";
import { BrowserLaunchError } from "./open-browser.js";
import { openDefaultBrowser } from "./open-browser.js";
import { FlowCancelledError, FlowInterruptedError } from "./flow-cancel.js";

type Config = { rpcUrl: string; chainId: number; agentId?: Address; agentIds?: Address[]; aliases?: Record<string, string>; factory?: Address; implementation: Address;
  execution?: { bundlerRpcUrl: string; maxGasCostWei?: string };
  authenticatorLabels?: Record<string, string[]>;
  deploymentBlockNumber?: string; deploymentBlockHash?: Hex;
  signer?: { kind: "secure-enclave" | "windows-tpm"; binaryPath: string; label: string } };

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function parseConfig(value: unknown): Config {
  const schema = z.strictObject({
    execution: z.strictObject({ bundlerRpcUrl: z.url(), maxGasCostWei: z.string().regex(/^[1-9][0-9]*$/).optional() }).optional(),
    rpcUrl: z.url(), chainId: z.int().positive(), agentId: z.string().optional(), agentIds: z.array(z.string()).max(256).optional(), aliases: z.record(z.string(), z.string()).optional(), factory: z.string().optional(), implementation: z.string().optional(),
    authenticatorLabels: z.record(z.string(), z.array(z.string().min(1).refine(label => Buffer.byteLength(label) <= 128 && !/[\x00-\x1f\x7f]/.test(label))).max(256)).optional(),
    deploymentBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    deploymentBlockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    signer: z.strictObject({ kind: z.enum(["secure-enclave", "windows-tpm"]), binaryPath: z.string().refine(isAbsolute, "Signer path must be absolute"), label: z.string().min(1).max(128) }).optional(),
  });
  const parsed = schema.parse(value);
  if (parsed.signer && ((parsed.signer.kind === "secure-enclave" && process.platform !== "darwin") ||
      (parsed.signer.kind === "windows-tpm" && process.platform !== "win32"))) throw new Error("Signer kind does not match this host platform");
  if ((parsed.agentId && !isAddress(parsed.agentId)) || parsed.agentIds?.some(id => !isAddress(id)) ||
      (parsed.factory && !isAddress(parsed.factory)) || (parsed.implementation && !isAddress(parsed.implementation))) throw new Error("Invalid account, factory, or implementation address");
  for (const [id, alias] of Object.entries(parsed.aliases ?? {})) {
    if (!isAddress(id) || alias !== alias.trim() || alias.length < 1 || alias.length > 40 || /[\x00-\x1f\x7f]/.test(alias))
      throw new Error("Invalid agent alias");
  }
  if (Object.keys(parsed.authenticatorLabels ?? {}).some(id => !isAddress(id))) throw new Error("Invalid authenticator label agent ID");
  if (!!parsed.deploymentBlockNumber !== !!parsed.deploymentBlockHash) throw new Error("Deployment fingerprint requires both block number and hash");
  const rpc = new URL(parsed.rpcUrl);
  if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname))) throw new Error("RPC must use HTTPS or loopback HTTP");
  // Validate historical explicit pins before migrating creation to the current
  // release. IDs and labels remain untouched; unknown overrides still fail.
  const factory = trustedFactory(parsed.chainId, parsed.factory ? getAddress(parsed.factory) : undefined);
  const implementation = trustedImplementation(parsed.chainId, parsed.implementation ? getAddress(parsed.implementation) : undefined);
  return { ...parsed, agentId: parsed.agentId ? getAddress(parsed.agentId) : undefined,
    agentIds: parsed.agentIds?.map(id => getAddress(id)), aliases: Object.fromEntries(Object.entries(parsed.aliases ?? {}).map(([id, alias]) => [id.toLowerCase(), alias])),
    authenticatorLabels: Object.fromEntries(Object.entries(parsed.authenticatorLabels ?? {}).map(([id, labels]) => [id.toLowerCase(), [...new Set(labels)]])),
    factory: parsed.chainId === SEPOLIA_CHAIN_ID ? SEPOLIA_DEPLOYMENT.factory : factory,
    implementation: parsed.chainId === SEPOLIA_CHAIN_ID ? SEPOLIA_DEPLOYMENT.implementation : implementation,
    deploymentBlockHash: parsed.deploymentBlockHash as Hex | undefined };
}

export async function createAgenticWorldMcp(configValue: unknown, operatingKey?: Hex, configPath?: string,
  options: { openBrowser?: (url: string) => Promise<void> } = {}) {
  const config = parseConfig(configValue);
  if (config.chainId === SEPOLIA_CHAIN_ID && operatingKey) throw new Error("Sepolia requires a hardware-backed P-256 signer");
  if (!config.signer && !operatingKey) throw new Error("Configure a local P-256 signer or the demo-only operating key");
  if (operatingKey && !/^0x[0-9a-fA-F]{64}$/.test(operatingKey)) throw new Error("Invalid operating key");
  if (config.signer && operatingKey) throw new Error("Do not provide an operating key when a hardware P-256 signer is configured");
  const legacySigner = operatingKey ? privateKeyToAccount(operatingKey) : undefined;
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const server = new McpServer({ name: "agentic-world", version: "0.1.0" }, { capabilities: { tools: {} } });
  let creatingIdentity = false;
  let ownerActionInProgress = false;
  let portal: { server: Server; url: string } | undefined;
  let persistQueue: Promise<void> = Promise.resolve();
  const openBrowser = options.openBrowser ?? openDefaultBrowser;

  async function signerForKey(agentId: Address, publicKey: { qx: Hex; qy: Hex }, additionalLabel?: string) {
    if (!config.signer) throw new ToolError("SIGNER_UNAVAILABLE", "No local hardware signer is configured");
    const labels = [...new Set([...(additionalLabel ? [additionalLabel] : []),
      ...(config.authenticatorLabels?.[agentId.toLowerCase()] ?? []), config.signer.label])];
    for (const label of labels) {
      const signer = { ...config.signer, label };
      try {
        const key = await signerPublicKey(signer);
        if (key.qx.toLowerCase() === publicKey.qx.toLowerCase() && key.qy.toLowerCase() === publicKey.qy.toLowerCase()) return signer;
      } catch { /* A missing pending key must not mask another retained key. */ }
    }
    throw new ToolError("AUTHENTICATOR_MISMATCH", "No retained local hardware key matches this authenticator; use a provisioned keyLabel or rotate through the MCP");
  }

  async function requireNativeP256() {
    // Known-valid EIP-7951 vector also used by OpenZeppelin to detect precompile presence.
    const probe = concatHex([
      "0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023",
      "0x0000000000000000000000000000000000000000000000000000000000000005",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0xa71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957",
      "0x5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b",
    ]);
    const result = await client.call({ to: "0x0000000000000000000000000000000000000100", data: probe });
    if (result.data !== `0x${"0".repeat(63)}1`) throw new ToolError("P256_PRECOMPILE_UNAVAILABLE", "The configured chain does not support EIP-7951 P256VERIFY at 0x100");
  }

  function managedAgentIds(): Address[] {
    return [...new Map([...(config.agentId ? [config.agentId] : []), ...(config.agentIds ?? [])]
      .map(id => [id.toLowerCase(), id] as const)).values()];
  }

  function persistConfig(): Promise<void> {
    if (!configPath) return Promise.resolve();
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      const temp = `${configPath}.${randomBytes(4).toString("hex")}.tmp`;
      const persisted = { ...config };
      if (config.chainId === SEPOLIA_CHAIN_ID) {
        Reflect.deleteProperty(persisted, "factory");
        Reflect.deleteProperty(persisted, "implementation");
      }
      await writeFile(temp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, configPath);
    });
    return persistQueue;
  }

  function validatedAlias(alias: string): string {
    const value = alias.trim();
    if (value.length < 1 || value.length > 40 || /[\x00-\x1f\x7f]/.test(value))
      throw new ToolError("INVALID_ALIAS", "Alias must be 1–40 printable characters");
    return value;
  }

  async function listIdentities() {
    const ids = managedAgentIds();
    if (!ids.length) return { count: 0, identities: [] };
    const [actualChain, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
    if (actualChain !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const identities = await Promise.all(ids.map(async agentId => {
      const code = await client.getBytecode({ address: agentId, blockNumber });
      const deployment = accountDeployment(code);
      if (!deployment)
        return { agentId, alias: config.aliases?.[agentId.toLowerCase()] ?? null, status: "UNAVAILABLE" as const };
      const [owner, revoked] = await Promise.all([
        client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "owner", blockNumber }),
        client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticationRevoked", blockNumber }),
      ]);
      return { agentId, alias: config.aliases?.[agentId.toLowerCase()] ?? null, owner,
        executionSupported: deployment.implementation.toLowerCase() === config.implementation.toLowerCase(),
        status: revoked ? "REVOKED" as const : "ACTIVE" as const, authenticationRevoked: revoked };
    }));
    return { count: identities.length, blockNumber: blockNumber.toString(), identities };
  }

  function selectManagedAgentId(requested?: string): Address {
    const known = managedAgentIds();
    if (requested && !isAddress(requested)) throw new ToolError("INVALID_AGENT", "Invalid agent ID");
    if (requested) {
      const selected = known.find(id => id.toLowerCase() === requested.toLowerCase());
      if (!selected) throw new ToolError("UNMANAGED_AGENT", "Add this agent ID to the trusted local config before owner actions");
      return selected;
    }
    if (known.length === 0) throw new ToolError("IDENTITY_NOT_CONFIGURED", "No agent identity is configured");
    if (known.length > 1) throw new ToolError("AGENT_SELECTION_REQUIRED", "Choose an agent ID from agentic_list_identities before an owner action");
    return known[0];
  }

  function accountDeployment(code: Hex | undefined) {
    return config.chainId === SEPOLIA_CHAIN_ID ? resolveSepoliaAgentDeployment(code)
      : isExpectedAgentClone(code, config.implementation) ? { factory: config.factory, implementation: config.implementation } : undefined;
  }

  async function pinnedAccountBlock(agentId: Address) {
    const [actualChain, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
    if (actualChain !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const code = await client.getBytecode({ address: agentId, blockNumber });
    const deployment = accountDeployment(code);
    if (!deployment) throw new ToolError("IDENTITY_UNAVAILABLE", "Agent is not a recognized pinned ERC-4337 account clone");
    return { blockNumber, deployment };
  }

  async function identity(agentId = config.agentId) {
    if (!agentId) throw new ToolError("IDENTITY_NOT_CONFIGURED", "Create an agent identity and configure its address first");
    const { blockNumber, deployment } = await pinnedAccountBlock(agentId);
    const [owner, authenticator, scheme, p256PublicKey, revoked, createdAt, policyHash, policyRevision] = await Promise.all([
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "owner", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticator", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticatorScheme", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticatorP256", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticationRevoked", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "createdAt", blockNumber }),
      client.readContract({ address: agentId, abi: agentPolicyAbi, functionName: "policyHash", blockNumber }),
      client.readContract({ address: agentId, abi: agentPolicyAbi, functionName: "policyRevision", blockNumber }),
    ]);
    return { agentId, chainId: config.chainId, factory: deployment.factory, implementation: deployment.implementation,
      executionSupported: deployment.implementation.toLowerCase() === config.implementation.toLowerCase(),
      owner, authenticatorScheme: scheme,
      authenticator: scheme === 1 ? authenticator : undefined,
      p256PublicKey: scheme === 2 ? { qx: p256PublicKey[0], qy: p256PublicKey[1] } : undefined,
      authenticationRevoked: revoked,
      createdAt: Number(createdAt), policyHash, policyRevision: policyRevision.toString(), blockNumber: blockNumber.toString() };
  }

  async function authenticationState(agentId: Address) {
    const { blockNumber } = await pinnedAccountBlock(agentId);
    const [scheme, revoked, authenticator, p256PublicKey] = await Promise.all([
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticatorScheme", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticationRevoked", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticator", blockNumber }),
      client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticatorP256", blockNumber }),
    ]);
    return { agentId, authenticatorScheme: scheme, authenticationRevoked: revoked,
      authenticator: scheme === 1 ? authenticator : undefined,
      p256PublicKey: scheme === 2 ? { qx: p256PublicKey[0], qy: p256PublicKey[1] } : undefined };
  }

  function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
  async function guarded(fn: () => Promise<unknown>) {
    try { return result(await fn()); }
    catch (error) {
      const code = error instanceof ToolError ? error.code : error instanceof BrowserLaunchError ? "BROWSER_UNAVAILABLE"
        : error instanceof FlowCancelledError ? "FLOW_CANCELLED" : error instanceof FlowInterruptedError ? "FLOW_INTERRUPTED" : "OPERATION_FAILED";
      // Never serialize transport errors: URLs can contain credentials and upstream messages can echo request data.
      return { ...result({ code, message: error instanceof ToolError ? error.message : error instanceof BrowserLaunchError
        ? "Could not open the local approval page in the default browser" : error instanceof FlowCancelledError || error instanceof FlowInterruptedError
        ? error.message : "Agentic World operation failed; check server diagnostics",
        ...(error instanceof FlowCancelledError ? { retrySafe: true } : {}),
        ...(error instanceof FlowInterruptedError ? { retrySafe: false, transactionHash: error.transactionHash } : {}),
      }), isError: true };
    }
  }

  server.registerTool("agentic_identity", { description: "Read the configured onchain agent identity and current authentication state.", inputSchema: z.object({}) },
    async () => guarded(async () => {
      if (config.agentId) return identity();
      const actualChain = await client.getChainId();
      if (actualChain !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
      return { configured: false, chainId: config.chainId, factory: config.factory,
        implementation: config.implementation, next: "Provision a local signer, then call agentic_create_identity to prepare an owner wallet transaction." };
    }));

  function paymentResult(record: PaymentRecord) {
    const { operation: _operation, ...publicRecord } = record;
    return { ...publicRecord, paid: record.status === "CONFIRMED" && record.kind !== "allowance", token: SEPOLIA_USDC,
      purchaseConfirmed: record.kind === "purchase" && record.status === "CONFIRMED",
      allowanceConfirmed: record.kind === "allowance" && record.status === "CONFIRMED",
      note: record.status === "CONFIRMED" ? record.kind === "allowance" ? "Exact allowance verified. No purchase or payment completed."
        : record.kind === "purchase" ? "Exact USDC transfer and Service C Purchased event verified onchain."
        : "Exact USDC transfer verified from the chain receipt." : "Not confirmed paid. Check this requestId; never create a second payment to retry an unknown submission." };
  }
  async function paymentExecutor(journal: Parameters<Parameters<typeof withPaymentJournal>[1]>[0], signal?: AbortSignal) {
    const url = config.execution?.bundlerRpcUrl ?? process.env.AGENTIC_WORLD_BUNDLER_RPC_URL;
    if (!url) throw new ToolError("BUNDLER_REQUIRED", "Configure execution.bundlerRpcUrl or AGENTIC_WORLD_BUNDLER_RPC_URL with a Sepolia Pimlico endpoint. No funds were sent.");
    return createPaymentExecutor({ client, chainId: config.chainId, implementation: config.implementation,
      bundler: pimlicoBundler(url), journal, signal,
      maxGasCostWei: config.execution?.maxGasCostWei ? BigInt(config.execution.maxGasCostWei) : undefined,
      sign: async request => {
        if (signal?.aborted) throw new Error("Payment cancelled before signing");
        const current = await authenticationState(selectManagedAgentId(request.userOperation.sender));
        if (current.authenticationRevoked || !current.p256PublicKey) throw new Error("Payment requires an active hardware-backed P-256 key");
        return signLocalExecution(await signerForKey(current.agentId, current.p256PublicKey), request);
      },
      approve: async (typedData, intent) => {
        if (ownerActionInProgress) throw new Error("Another owner approval is open");
        ownerActionInProgress = true;
        try {
          const current = await identity(intent.agentId);
          return await approvePayment({ owner: current.owner, typedData, intent, openBrowser, signal,
            verify: signature => client.verifyTypedData({ address: current.owner, ...typedData, signature }) });
        } finally { ownerActionInProgress = false; }
      },
    });
  }
  server.registerTool("agentic_pay_usdc", {
    description: "Spend Sepolia USDC from the selected agent via ERC-4337, subject to its onchain transfer policy. Requires an explicit user payment request. Opens owner approval when policy requires it. Use a stable requestId for retries; SUBMITTED is not paid.",
    inputSchema: z.strictObject({ agentId: z.string().optional(), recipient: z.string(), amount: z.string(), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) }),
  }, async ({ agentId, recipient, amount, requestId }, ctx) => guarded(async () => {
    if (!configPath) throw new ToolError("PERSISTENT_CONFIG_REQUIRED", "Payments require a persistent MCP config and payment journal");
    if (!isAddress(recipient)) throw new ToolError("INVALID_RECIPIENT", "Provide the recipient address explicitly");
    const selected = selectManagedAgentId(agentId);
    if (!(await identity(selected)).executionSupported)
      throw new ToolError("EXECUTION_UPGRADE_REQUIRED", "This legacy agent remains usable for authentication. Payments require a new agent from the current factory; the existing identity was not changed.");
    return withPaymentJournal(configPath, async journal => paymentResult(await (await paymentExecutor(journal, ctx.mcpReq.signal)).pay(requestId, { agentId: selected, recipient, amount })));
  }));
  server.registerTool("agentic_payment_status", {
    description: "Check a persisted payment without resubmitting. CONFIRMED means both the EntryPoint operation and exact USDC transfer were verified onchain.",
    inputSchema: z.strictObject({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) }),
  }, async ({ requestId }) => guarded(async () => {
    if (!configPath) throw new ToolError("PERSISTENT_CONFIG_REQUIRED", "No payment journal is configured");
    return withPaymentJournal(configPath, async journal => paymentResult(await (await paymentExecutor(journal)).status(requestId)));
  }));
  for (const [name, kind] of [["agentic_purchase_compute", "purchase"], ["agentic_approve_compute_allowance", "allowance"]] as const) {
    server.registerTool(name, {
      description: kind === "purchase"
        ? "Actually purchase Service C compute using Sepolia USDC and the account's purchase policy. Requires an explicit purchase request, funded account, bundler and sufficient allowance. Verify purchaseConfirmed through agentic_payment_status."
        : "Set a bounded USDC allowance for the exact Service C purchase amount. Requires owner approval and an onchain approve rule requiring owner signature. Does not purchase or pay. Never grant an unlimited allowance.",
      inputSchema: z.strictObject({ agentId: z.string().optional(), target: z.string(), amount: z.string(), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) }),
    }, async ({ agentId, target, amount, requestId }, ctx) => guarded(async () => {
      if (!configPath) throw new ToolError("PERSISTENT_CONFIG_REQUIRED", "Purchases require a persistent config and payment journal");
      if (!isAddress(target)) throw new ToolError("INVALID_TARGET", "Provide the Service C purchase contract address");
      const selected = selectManagedAgentId(agentId);
      if (!(await identity(selected)).executionSupported) throw new ToolError("EXECUTION_UPGRADE_REQUIRED", "This agent does not support execution");
      return withPaymentJournal(configPath, async journal => paymentResult(await (await paymentExecutor(journal, ctx.mcpReq.signal))
        .pay(requestId, { agentId: selected, recipient: target, amount, kind })));
    }));
  }
  server.registerTool("agentic_enable_compute_allowance", {
    description: "Owner-requested one-time purchase setup. Preserve existing purchase rules and append a USDC approve rule requiring an exact owner signature. Opens a wallet transaction. Does not grant an allowance or change purchase limits.",
    inputSchema: z.strictObject({ agentId: z.string().optional() }),
  }, async ({ agentId }, ctx) => guarded(async () => {
    const current = await identity(selectManagedAgentId(agentId));
    const encoded = await client.readContract({ address: current.agentId, abi: agentPolicyAbi, functionName: "policy" });
    let rules: PolicyRule[];
    try { rules = decodePolicy(encoded); } catch { throw new ToolError("PURCHASE_POLICY_REQUIRED", "Configure purchase rules first. Transfer-only policies are not changed by this setup."); }
    if (!rules.some(rule => rule.selector.toLowerCase() === "0x95f43b71" && rule.decision !== Decision.DENY))
      throw new ToolError("PURCHASE_POLICY_REQUIRED", "Configure an allowed purchase rule first");
    const existing = rules.find(rule => rule.target.toLowerCase() === SEPOLIA_USDC.toLowerCase() && rule.selector.toLowerCase() === "0x095ea7b3");
    if (existing) {
      if (existing.decision !== Decision.REQUIRE_OWNER_SIGNATURE) throw new ToolError("ALLOWANCE_POLICY_CONFLICT", "Existing approval policy must be reviewed by the owner; it was not changed");
      return { status: "ALREADY_CONFIGURED", agentId: current.agentId };
    }
    const policy = encodePolicy([...rules, { target: SEPOLIA_USDC, selector: "0x095ea7b3", token: zeroAddress, maxValue: 0n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE }]);
    const policyHash = keccak256(policy);
    return approveOwnerAction({ action: "policy", agentId: current.agentId,
      summary: "Enable owner-approved USDC allowances for purchases. Existing purchase rules remain unchanged. Each allowance requires your separate signature for its exact contract and amount.",
      details: [`Preserve ${rules.length} existing rules`, "Append USDC approve(address,uint256): REQUIRE_OWNER_SIGNATURE", "No allowance or payment is created by this transaction"],
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data: encodeFunctionData({ abi: agentPolicyAbi, functionName: "setPolicy", args: [policy] }) } },
      async () => { const updated = await identity(current.agentId); if (updated.policyHash !== policyHash) throw new Error("Policy confirmation mismatch"); return { policyHash, policyRevision: updated.policyRevision }; },
      { module: "policyHook", abi: parseAbiItem("event PolicyUpdated(address indexed account, bytes32 indexed policyHash, uint256 revision)"), matches: args => args.policyHash === policyHash }, ctx.mcpReq.signal);
  }));
  server.registerTool("agentic_set_transfer_policy", {
    description: "Replace this agent's execution policy with ordered, recipient-bound USDC transfer rules. Requires explicit owner request and a wallet transaction. No match means DENY; limits are per transfer, not cumulative.",
    inputSchema: z.strictObject({ agentId: z.string().optional(), rules: z.array(z.strictObject({ recipient: z.string(), maxUsdc: z.string(), decision: z.enum(["DENY", "ALLOW", "REQUIRE_OWNER_SIGNATURE"]) })).max(32) }),
  }, async ({ agentId, rules }, ctx) => guarded(async () => {
    const current = await identity(selectManagedAgentId(agentId));
    try {
      if (await client.readContract({ address: current.agentId, abi: executionAccountAbi, functionName: "executionVersion" }) !== 1n) throw new Error();
    } catch { throw new ToolError("EXECUTION_UPGRADE_REQUIRED", "Transfer policies require a newly deployed execution account; the old Sepolia account is unchanged."); }
    const encoded = encodeTransferPolicy(rules.map(rule => {
      if (!isAddress(rule.recipient)) throw new ToolError("INVALID_RECIPIENT", "Invalid policy recipient");
      return { token: SEPOLIA_USDC, recipient: rule.recipient, maxAmount: paymentAmount(rule.maxUsdc), decision: Decision[rule.decision] };
    }));
    const policyHash = keccak256(encoded);
    const data = encodeFunctionData({ abi: agentPolicyAbi, functionName: "setPolicy", args: [encoded] });
    await client.call({ account: current.owner, to: current.agentId, data });
    return approveOwnerAction({ action: "policy", agentId: current.agentId,
      summary: "Replace the existing execution policy with these per-transfer USDC limits. Other actions will be denied.",
      details: rules.map((rule, i) => `${i + 1}. ${rule.decision}: up to ${rule.maxUsdc} USDC to ${rule.recipient}`),
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data } },
      async () => {
        const updated = await identity(current.agentId);
        if (updated.policyHash !== policyHash || BigInt(updated.policyRevision) <= BigInt(current.policyRevision)) throw new Error("Policy confirmation mismatch");
        return { policyHash, policyRevision: updated.policyRevision };
      }, { module: "policyHook", abi: parseAbiItem("event PolicyUpdated(address indexed account, bytes32 indexed policyHash, uint256 revision)"),
        matches: args => args.policyHash === policyHash && typeof args.revision === "bigint" && args.revision > BigInt(current.policyRevision) }, ctx.mcpReq.signal);
  }));

  server.registerTool("agentic_list_identities", { description: "List all locally known agent IDs, aliases, and current onchain revocation status, including revoked agents.", inputSchema: z.object({}) },
    async () => guarded(listIdentities));

  server.registerTool("agentic_set_alias", { description: "Set a local-only display alias for a managed agent ID; this changes no onchain state.",
    inputSchema: z.object({ agentId: z.string(), alias: z.string() }) },
    async ({ agentId, alias }) => guarded(async () => {
      const selected = selectManagedAgentId(agentId);
      config.aliases ??= {};
      config.aliases[selected.toLowerCase()] = validatedAlias(alias);
      await persistConfig();
      return { agentId: selected, alias: config.aliases[selected.toLowerCase()] };
    }));

  server.registerTool("agentic_portal", { description: "Open the local owner portal to view managed agents, edit aliases, and set their onchain execution policies.", inputSchema: z.object({}) },
    async () => guarded(async () => {
      if (portal) { await openBrowser(portal.url); return { status: "PORTAL_OPEN", url: portal.url }; }
      const token = randomBytes(24).toString("hex");
      const prefix = `/portal/${token}/`;
      let base = "";
      const site = createServer(async (request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(value));
        };
        if (request.headers.host !== base.slice("http://".length) || !path.startsWith(prefix)) { send(404, { error: "Not found" }); return; }
        if (request.method === "GET" && path === `${prefix}api/identities`) {
          try { send(200, { ...await listIdentities(), creationAvailable: !!config.signer }); }
          catch { send(503, { error: "Could not read agent identities from the configured chain" }); }
          return;
        }
        if (request.method === "POST" && [`${prefix}api/create`, `${prefix}api/signer`].includes(path)) {
          if (request.headers.origin !== base || !request.headers["content-type"]?.startsWith("application/json")) {
            send(403, { error: "Request rejected" }); return;
          }
          const controller = new AbortController();
          const disconnected = () => { if (!response.writableEnded) controller.abort(); };
          response.once("close", disconnected);
          try {
            let body = "";
            for await (const chunk of request) { body += chunk.toString(); if (body.length > 1024) { send(413, { error: "Request too large" }); return; } }
            const input: unknown = JSON.parse(body);
            const outcome = await guarded(async () => {
              if (path === `${prefix}api/create`) {
                const parsed = z.strictObject({ alias: z.string().optional() }).safeParse(input);
                if (!parsed.success) throw new ToolError("INVALID_CREATION_INPUT", "Provide only an optional alias; keys and deployment values are generated locally");
                return createIdentity(parsed.data.alias, controller.signal);
              }
              const parsed = z.strictObject({ agentId: z.string(), action: z.enum(["rotate", "restore"]) }).safeParse(input);
              if (!parsed.success) throw new ToolError("INVALID_KEY_INPUT", "Select an agent and key action; replacement keys are generated locally");
              return rotateAuthenticator({ scheme: "p256", agentId: parsed.data.agentId }, controller.signal, parsed.data.action === "restore");
            });
            const value = JSON.parse(outcome.content[0].text);
            send("isError" in outcome && outcome.isError ? (["CREATION_IN_PROGRESS", "OWNER_ACTION_IN_PROGRESS"].includes(value.code) ? 409 : 400) : 200, value);
          } catch { send(400, { error: "Could not start local owner approval" }); }
          finally { response.off("close", disconnected); }
          return;
        }
        if (request.method === "POST" && path === `${prefix}api/alias`) {
          if (request.headers.origin !== base || !request.headers["content-type"]?.startsWith("application/json")) { send(403, { error: "Request rejected" }); return; }
          try {
            let body = "";
            for await (const chunk of request) { body += chunk.toString(); if (body.length > 1024) throw new Error("Too large"); }
            const input: unknown = JSON.parse(body);
            if (!input || typeof input !== "object" || !("agentId" in input) || !("alias" in input) ||
                typeof input.agentId !== "string" || typeof input.alias !== "string") throw new Error("Invalid alias input");
            const agentId = selectManagedAgentId(input.agentId);
            config.aliases ??= {};
            config.aliases[agentId.toLowerCase()] = validatedAlias(input.alias);
            await persistConfig();
            send(200, { agentId, alias: config.aliases[agentId.toLowerCase()] });
          } catch { send(400, { error: "Could not save alias" }); }
          return;
        }
        if (request.method === "POST" && path === `${prefix}api/adopt` && request.headers.origin === base && request.headers["content-type"]?.startsWith("application/json")) {
          try {
            let body = "";
            for await (const chunk of request) { body += chunk.toString(); if (body.length > 1024) throw new Error("Too large"); }
            const input: unknown = JSON.parse(body);
            if (!input || typeof input !== "object" || !("agentId" in input) || typeof input.agentId !== "string" || !isAddress(input.agentId)) throw new Error("Invalid agent");
            const agentId = getAddress(input.agentId);
            const current = await identity(agentId);
            if (config.signer) {
              if (current.authenticatorScheme !== 2 || !current.p256PublicKey) throw new Error("Agent does not use P-256");
              await signerForKey(agentId, current.p256PublicKey);
            } else if (current.authenticator?.toLowerCase() !== legacySigner?.address.toLowerCase()) throw new Error("Agent key does not match local signer");
            config.agentIds = [...new Map([...managedAgentIds(), agentId].map(id => [id.toLowerCase(), id] as const)).values()];
            config.agentId = agentId;
            if ("alias" in input && typeof input.alias === "string" && input.alias.trim()) {
              config.aliases ??= {}; config.aliases[agentId.toLowerCase()] = validatedAlias(input.alias);
            }
            await persistConfig();
            send(200, { agentId, alias: config.aliases?.[agentId.toLowerCase()] ?? null });
          } catch { send(400, { error: "Could not register this agent with the local signer" }); }
          return;
        }
        if (request.method === "POST" && path === `${prefix}api/close` && request.headers.origin === base) {
          send(200, { closed: true });
          site.close(); portal = undefined;
          return;
        }
        const file = path === prefix ? "index.html" : path.slice(prefix.length);
        if (request.method !== "GET" || !["index.html", "main.js", "styles.css"].includes(file)) { send(404, { error: "Not found" }); return; }
        try {
          const primary = new URL(`../../portal/dist/${file}`, import.meta.url);
          const fallback = new URL(`../portal/dist/${file}`, import.meta.url);
          const bytes = await readFile(fileURLToPath(primary)).catch(() => readFile(fileURLToPath(fallback)));
          response.writeHead(200, { ...headers, "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
          response.end(bytes);
        } catch { send(503, { error: "Portal assets are missing; run npm run build:portal" }); }
      });
      await new Promise<void>((resolve, reject) => { site.once("error", reject); site.listen(0, "127.0.0.1", () => { site.off("error", reject); resolve(); }); });
      const address = site.address();
      if (!address || typeof address === "string") { site.close(); throw new ToolError("PORTAL_UNAVAILABLE", "Could not bind portal to loopback"); }
      base = `http://127.0.0.1:${address.port}`;
      portal = { server: site, url: `${base}${prefix}` };
      try { await openBrowser(portal.url); }
      catch (error) { site.close(); portal = undefined; throw error; }
      return { status: "PORTAL_OPEN", url: `${base}${prefix}` };
    }));

  server.registerTool("agentic_policy_check", {
    description: "Preview current onchain policy for an EVM action. This is not execution authorization; policy is rechecked during execution.",
    inputSchema: z.object({ agentId: z.string().optional(), target: z.string(), valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/), data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/) }),
  }, async ({ agentId, target, valueWei, data }) => guarded(async () => {
    if (!isAddress(target)) throw new ToolError("INVALID_ACTION", "Invalid target address");
    const current = await identity(selectManagedAgentId(agentId));
    const decision = await client.readContract({ address: current.agentId, abi: agentPolicyAbi, functionName: "evaluateAction",
      args: [target, BigInt(valueWei), data as Hex], blockNumber: BigInt(current.blockNumber) });
    return { decision: decision === Decision.ALLOW ? "ALLOW" : decision === Decision.REQUIRE_OWNER_SIGNATURE ? "REQUIRE_OWNER_SIGNATURE" : "DENY",
      policyHash: current.policyHash, policyRevision: current.policyRevision, blockNumber: current.blockNumber, previewOnly: true };
  }));

  async function assertTrustedFactory() {
    if (!config.factory) throw new ToolError("FACTORY_NOT_CONFIGURED", "Configure a trusted factory address");
    if (await client.getChainId() !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const factoryCode = await client.getBytecode({ address: config.factory });
    if (!factoryCode || factoryCode === "0x") throw new ToolError("FACTORY_UNAVAILABLE", "Trusted factory is not deployed");
    const implementation = await client.readContract({ address: config.factory, abi: agentAccountFactoryAbi, functionName: "implementation" });
    if (implementation.toLowerCase() !== config.implementation.toLowerCase())
      throw new ToolError("IMPLEMENTATION_MISMATCH", "Factory implementation differs from the trusted pin");
    if (config.chainId === SEPOLIA_CHAIN_ID) {
      const [validator, policyHook] = await Promise.all([
        client.readContract({ address: config.factory, abi: agentAccountFactoryAbi, functionName: "validator" }),
        client.readContract({ address: config.factory, abi: agentAccountFactoryAbi, functionName: "policyHook" }),
      ]);
      if (validator.toLowerCase() !== SEPOLIA_DEPLOYMENT.validator.toLowerCase() ||
          policyHook.toLowerCase() !== SEPOLIA_DEPLOYMENT.policyHook.toLowerCase())
        throw new ToolError("MODULE_MISMATCH", "Sepolia factory modules differ from the trusted deployment");
    }
  }

  async function prepareIdentity(owner: string, salt: Hex, providedKey?: Awaited<ReturnType<typeof signerPublicKey>>, prechecked = false) {
    const key = providedKey ?? (config.signer ? await signerPublicKey(config.signer) : undefined);
    if (!prechecked) await assertTrustedFactory();
    if (!config.factory) throw new ToolError("FACTORY_NOT_CONFIGURED", "Configure a trusted factory address");
    if (!isAddress(owner) || getAddress(owner) === zeroAddress) throw new ToolError("INVALID_OWNER", "Expected a human owner wallet address");
    const predictedAgent = await client.readContract({ address: config.factory, abi: agentAccountFactoryAbi,
      functionName: "predictAgent", args: [getAddress(owner), salt as Hex] });
    const existingCode = await client.getBytecode({ address: predictedAgent });
    if (existingCode && existingCode !== "0x") throw new ToolError("IDENTITY_ALREADY_EXISTS", "An agent already exists for this owner and salt");
    if (!key && !legacySigner) throw new ToolError("SIGNER_UNAVAILABLE", "No local signer is configured");
    if (key && !prechecked) await requireNativeP256();
    const data = key
      ? encodeFunctionData({ abi: agentAccountFactoryAbi, functionName: "createAgentP256", args: [key.qx, key.qy, salt as Hex] })
      : encodeFunctionData({ abi: agentAccountFactoryAbi, functionName: "createAgent", args: [legacySigner!.address, salt as Hex] });
    return { status: "OWNER_TRANSACTION_REQUIRED", predictedAgent, authenticator: key ?? { scheme: "secp256k1-demo", address: legacySigner!.address },
      transaction: { chainId: config.chainId, from: getAddress(owner), to: config.factory, value: "0", data },
      next: "The human owner must review and send this transaction from the owner wallet, then configure agentId to the deployed address." };
  }

  async function confirmCreatedIdentity(hash: Hex, key: Awaited<ReturnType<typeof signerPublicKey>>,
    expected?: CreationIntent, alias?: string) {
    if (!config.factory) throw new ToolError("FACTORY_NOT_CONFIGURED", "Configure a trusted factory address");
    if (await client.getChainId() !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new ToolError("TRANSACTION_REVERTED", "Owner transaction reverted");
    // Smart wallets may wrap the call or use a relayer. The outer transaction's
    // from/to/input do not describe the factory call. The pinned factory event
    // binds the actual msg.sender owner, deterministic agent and exact P-256 key.
    const event = parseAbiItem("event AgentCreatedP256(address indexed agent,address indexed owner,bytes32 qx,bytes32 qy)");
    const matches = receipt.logs.flatMap(log => {
      if (log.address.toLowerCase() !== config.factory!.toLowerCase()) return [];
      try {
        const { args } = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
        if (args.qx.toLowerCase() !== key.qx.toLowerCase() || args.qy.toLowerCase() !== key.qy.toLowerCase() ||
            (expected && (args.agent.toLowerCase() !== expected.predictedAgent.toLowerCase() ||
              args.owner.toLowerCase() !== expected.transaction.from.toLowerCase()))) return [];
        return [args];
      } catch { return []; }
    });
    if (matches.length !== 1) throw new ToolError("CREATION_EVENT_MISSING", "Receipt must contain exactly one matching agent creation event from the trusted factory");
    const created = matches[0];
    const code = await client.getBytecode({ address: created.agent, blockNumber: receipt.blockNumber });
    if (!isExpectedAgentClone(code, config.implementation)) throw new ToolError("IDENTITY_UNAVAILABLE", "Created agent is not the pinned ERC-4337 account clone");
    const current = await identity(created.agent);
    if (current.owner.toLowerCase() !== created.owner.toLowerCase() || current.authenticatorScheme !== 2 ||
        current.p256PublicKey?.qx.toLowerCase() !== key.qx.toLowerCase() || current.p256PublicKey?.qy.toLowerCase() !== key.qy.toLowerCase() ||
        current.authenticationRevoked) throw new ToolError("IDENTITY_MISMATCH", "Current onchain owner or active authenticator does not match the approved identity");
    config.agentIds = [...new Map([...managedAgentIds(), created.agent].map(id => [id.toLowerCase(), id] as const)).values()];
    config.agentId = created.agent;
    if (alias) { config.aliases ??= {}; config.aliases[created.agent.toLowerCase()] = alias; }
    await persistConfig();
    return { agentId: created.agent, owner: created.owner, transactionHash: hash };
  }

  server.registerTool("agentic_create_identity", {
    description: "Open a local owner-wallet approval page to create a P-256 agent identity. Supply transactionHash to recover an already-created identity without another transaction. With explicit owner and salt, only prepare transaction data for a manual flow.",
    inputSchema: z.object({ owner: z.string().optional(), salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), alias: z.string().optional(),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }),
  }, async ({ owner, salt, alias, transactionHash }, ctx) => guarded(async () => {
    if (transactionHash) {
      if (owner || salt) throw new ToolError("INVALID_CREATION_INPUT", "Use transactionHash alone, optionally with an alias, to recover an identity");
      if (!config.signer) throw new ToolError("P256_SIGNER_REQUIRED", "Recovery requires the local P-256 authenticator used for creation");
      if (creatingIdentity) throw new ToolError("CREATION_IN_PROGRESS", "Close the existing creation page before recovery");
      const displayAlias = alias === undefined ? undefined : validatedAlias(alias);
      await assertTrustedFactory();
      const recovered = await confirmCreatedIdentity(transactionHash as Hex, await signerPublicKey(config.signer), undefined, displayAlias);
      return { status: "IDENTITY_RECOVERED", ...recovered, chainId: config.chainId,
        next: "Existing onchain identity verified and saved locally. No new transaction was submitted." };
    }
    if (owner || salt) {
      if (!owner || !salt) throw new ToolError("INVALID_CREATION_INPUT", "Provide both owner and salt, or neither for browser approval");
      return prepareIdentity(owner, salt as Hex);
    }
    return createIdentity(alias, ctx.mcpReq.signal);
  }));

  async function createIdentity(alias?: string, signal?: AbortSignal) {
    if (!config.signer) throw new ToolError("P256_SIGNER_REQUIRED", "Browser creation requires a local hardware P-256 signer");
    if (!config.factory) throw new ToolError("FACTORY_NOT_CONFIGURED", "Configure a trusted factory address");
    const displayAlias = alias === undefined ? undefined : validatedAlias(alias);
    if (creatingIdentity) throw new ToolError("CREATION_IN_PROGRESS", "An identity creation page is already open");
    creatingIdentity = true;
    try {
    await assertTrustedFactory();
    await requireNativeP256();
    const key = await ensureSignerPublicKey(config.signer);
    const creationSalt = `0x${randomBytes(32).toString("hex")}` as Hex;
    let selected: CreationIntent | undefined;
    const agentId = await runCreationFlow({ chainId: config.chainId, factory: config.factory, rpcUrl: config.rpcUrl, qx: key.qx, qy: key.qy,
      openBrowser, signal,
      deploymentBlockNumber: config.deploymentBlockNumber, deploymentBlockHash: config.deploymentBlockHash,
      prepare: async walletOwner => {
        const prepared = await prepareIdentity(walletOwner, creationSalt, key, true);
        selected = prepared;
        return prepared;
      },
      confirm: async (hash, intent) => {
        if (!selected || selected !== intent) throw new ToolError("INVALID_FLOW", "Owner transaction was not prepared by this flow");
        return (await confirmCreatedIdentity(hash, key, intent, displayAlias)).agentId;
      },
    });
    return { status: "IDENTITY_CREATED", agentId, alias: displayAlias ?? null, owner: selected?.transaction.from, chainId: config.chainId,
      next: "The onchain identity is confirmed and the local MCP config has been updated." };
    } finally { creatingIdentity = false; }
  }

  const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

  async function approveOwnerAction<T>(intent: OwnerActionIntent, verifyState: () => Promise<T>,
    expectedEvent: { module: "agentValidator" | "policyHook"; abi: AbiEvent; matches: (args: Record<string, unknown>) => boolean },
    signal?: AbortSignal) {
    if (ownerActionInProgress) throw new ToolError("OWNER_ACTION_IN_PROGRESS", "An owner approval page is already open");
    ownerActionInProgress = true;
    try {
      const confirmed = await runOwnerActionFlow({ intent, rpcUrl: config.rpcUrl,
        openBrowser, signal,
        deploymentBlockNumber: config.deploymentBlockNumber, deploymentBlockHash: config.deploymentBlockHash,
        confirm: async hash => {
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
          if (receipt.status !== "success") throw new ToolError("TRANSACTION_REVERTED", "Owner transaction reverted");
          if ((await client.getChainId()) !== intent.transaction.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain changed during owner approval");
          // Smart wallets may wrap or relay the owner call. Verify its effect
          // in this receipt using the account's immutable module as the emitter.
          const module = await client.readContract({ address: intent.agentId, abi: agentAccountAbi,
            functionName: expectedEvent.module, blockNumber: receipt.blockNumber });
          const matched = receipt.logs.some(log => {
            if (log.address.toLowerCase() !== module.toLowerCase()) return false;
            try {
              const { args } = decodeEventLog({ abi: [expectedEvent.abi], data: log.data, topics: log.topics });
              const fields = args as Record<string, unknown>;
              return typeof fields.account === "string" && fields.account.toLowerCase() === intent.agentId.toLowerCase() && expectedEvent.matches(fields);
            } catch { return false; }
          });
          if (!matched) throw new ToolError("TRANSACTION_MISMATCH", "Receipt does not contain the expected account module event for this owner action");
          return verifyState();
        },
      });
      return { status: "CONFIRMED_ONCHAIN", action: intent.action, agentId: intent.agentId,
        transactionHash: confirmed.hash, state: confirmed.state };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof Error && error.message.toLowerCase().includes("timed out"))
        throw new ToolError("OWNER_APPROVAL_TIMEOUT", "Owner approval timed out. Check the wallet and chain before retrying; a transaction may still be pending");
      if (error instanceof Error && error.message.includes("browser"))
        throw new ToolError("BROWSER_UNAVAILABLE", "Could not open the local owner-approval page in the default browser");
      throw error;
    } finally { ownerActionInProgress = false; }
  }

  server.registerTool("agentic_set_policy", {
    description: "Open owner-wallet approval for an onchain policy change; optionally return a read-only transaction preview.",
    inputSchema: z.object({ agentId: z.string().optional(), prepareOnly: z.boolean().optional(), rules: z.array(z.strictObject({
      target: z.string(), selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/), token: z.string(),
      maxValueWei: decimal, maxAmount: decimal, decision: z.enum(["DENY", "ALLOW", "REQUIRE_OWNER_SIGNATURE"]),
    })).max(32) }),
  }, async ({ agentId, rules, prepareOnly }, ctx) => guarded(async () => {
    const current = await identity(selectManagedAgentId(agentId));
    const parsed: PolicyRule[] = rules.map(rule => {
      if (!isAddress(rule.target) || !isAddress(rule.token)) throw new ToolError("INVALID_POLICY", "Invalid policy address");
      return { target: getAddress(rule.target), selector: rule.selector as Hex, token: getAddress(rule.token),
        maxValue: BigInt(rule.maxValueWei), maxAmount: BigInt(rule.maxAmount), decision: Decision[rule.decision] };
    });
    let encoded: Hex;
    try { encoded = encodePolicy(parsed); }
    catch { throw new ToolError("INVALID_POLICY", "Policy violates the account's rule schema"); }
    const policyHash = keccak256(encoded);
    if (policyHash === current.policyHash) throw new ToolError("POLICY_UNCHANGED", "The requested policy is already active");
    const data = encodeFunctionData({ abi: agentPolicyAbi, functionName: "setPolicy", args: [encoded] });
    try { await client.call({ account: current.owner, to: current.agentId, data }); }
    catch { throw new ToolError("POLICY_SIMULATION_FAILED", "The account rejected this policy; check the rules and owner state"); }
    const intent: OwnerActionIntent = { action: "policy", agentId: current.agentId,
      summary: "Change the onchain execution policy for this agent. This does not grant access to a service's resources.",
      details: [`New policy hash: ${policyHash}`, `Previous revision: ${current.policyRevision}`,
        ...parsed.map((rule, index) => `Rule ${index + 1}: ${rules[index].decision} · target ${rule.target} · selector ${rule.selector} · token ${rule.token} · max value ${rule.maxValue} wei · max amount ${rule.maxAmount}`)],
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data } };
    if (prepareOnly) return { status: "OWNER_TRANSACTION_REQUIRED", policyHash, ruleCount: parsed.length, transaction: intent.transaction };
    return approveOwnerAction(intent, async () => {
      const updated = await identity(current.agentId);
      if (updated.policyHash.toLowerCase() !== policyHash.toLowerCase() ||
          BigInt(updated.policyRevision) <= BigInt(current.policyRevision))
        throw new ToolError("POLICY_STATE_MISMATCH", "Confirmed transaction did not activate the expected policy");
      return { policyHash: updated.policyHash, policyRevision: updated.policyRevision };
    }, { module: "policyHook", abi: parseAbiItem("event PolicyUpdated(address indexed account, bytes32 indexed policyHash, uint256 revision)"),
      matches: args => args.policyHash === policyHash && typeof args.revision === "bigint" && args.revision > BigInt(current.policyRevision) }, ctx.mcpReq.signal);
  }));

  server.registerTool("agentic_rotate_authenticator", {
    description: "Open owner-wallet approval to rotate an authenticator; optionally return a read-only transaction preview.",
    inputSchema: z.discriminatedUnion("scheme", [
      z.strictObject({ scheme: z.literal("p256"), agentId: z.string().optional(), prepareOnly: z.boolean().optional(),
        qx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), qy: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
        keyLabel: z.string().min(1).refine(label => Buffer.byteLength(label) <= 128 && !/[\x00-\x1f\x7f]/.test(label)).optional() }),
      z.strictObject({ scheme: z.literal("secp256k1"), agentId: z.string().optional(), prepareOnly: z.boolean().optional(), address: z.string() }),
    ]),
  }, async (input, ctx) => guarded(async () => {
    return rotateAuthenticator(input, ctx.mcpReq.signal);
  }));

  async function rotateAuthenticator(input:
    { scheme: "p256"; agentId?: string; prepareOnly?: boolean; qx?: string; qy?: string; keyLabel?: string } |
    { scheme: "secp256k1"; agentId?: string; prepareOnly?: boolean; address: string },
    signal?: AbortSignal, restore = false) {
    if (restore && input.scheme !== "p256") throw new ToolError("P256_REQUIRED", "Portal restoration requires a hardware-backed P-256 key");
    if (ownerActionInProgress) throw new ToolError("OWNER_ACTION_IN_PROGRESS", "An owner approval page is already open");
    const current = await identity(selectManagedAgentId(input.agentId));
    if (!restore && current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_REVOKED", "A revoked authenticator must be restored by a separate owner action");
    if (restore && !current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_ACTIVE", "Only revoked authenticators can be restored");
    let data: Hex;
    let replacement: Awaited<ReturnType<typeof signerPublicKey>> | undefined;
    let replacementLabel: string | undefined;
    if (input.scheme === "p256") {
      await requireNativeP256();
      if (!!input.qx !== !!input.qy) throw new ToolError("INVALID_AUTHENTICATOR", "Provide both P-256 coordinates or neither for a new local key");
      if (input.qx && input.qy) {
        replacement = { scheme: "p256", qx: input.qx as Hex, qy: input.qy as Hex };
        if (config.signer) replacementLabel = (await signerForKey(current.agentId, replacement, input.keyLabel)).label;
      } else {
        if (input.prepareOnly) throw new ToolError("PUBLIC_KEY_REQUIRED", "A read-only rotation preview needs existing public coordinates; omit prepareOnly to provision a new key");
        if (!config.signer) throw new ToolError("P256_SIGNER_REQUIRED", "Rotation requires a local hardware P-256 signer");
        replacementLabel = input.keyLabel ?? `agentic-world-${current.agentId.slice(2).toLowerCase()}-${randomBytes(8).toString("hex")}`;
        replacement = input.keyLabel ? await signerPublicKey({ ...config.signer, label: replacementLabel })
          : await ensureSignerPublicKey({ ...config.signer, label: replacementLabel });
      }
      if (current.p256PublicKey?.qx.toLowerCase() === replacement.qx.toLowerCase() &&
          current.p256PublicKey?.qy.toLowerCase() === replacement.qy.toLowerCase()) throw new ToolError("AUTHENTICATOR_UNCHANGED", "That P-256 key is already active");
      data = encodeFunctionData({ abi: agentAccountAbi, functionName: restore ? "restoreP256Authenticator" : "rotateP256Authenticator", args: [replacement.qx, replacement.qy] });
    } else {
      if (config.chainId === SEPOLIA_CHAIN_ID) throw new ToolError("P256_REQUIRED", "Sepolia MCP only supports hardware-backed P-256 authenticators");
      if (!isAddress(input.address) || getAddress(input.address) === zeroAddress ||
          input.address.toLowerCase() === current.owner.toLowerCase() || input.address.toLowerCase() === current.agentId.toLowerCase()) {
        throw new ToolError("INVALID_AUTHENTICATOR", "Invalid operating address");
      }
      data = encodeFunctionData({ abi: agentAccountAbi, functionName: "rotateAuthenticator", args: [getAddress(input.address)] });
    }
    try { await client.call({ account: current.owner, to: current.agentId, data }); }
    catch { throw new ToolError("ROTATION_SIMULATION_FAILED", "The current account rejected this rotation; check the new key and owner state"); }
    const intent: OwnerActionIntent = { action: restore ? "restore" : "rotate", agentId: current.agentId,
      summary: restore ? "Restore this agent with a new hardware-backed authenticator." : "Replace this agent's operating authenticator. Existing service sessions may remain valid until they expire.",
      details: replacement ? [`New P-256 Qx: ${replacement.qx}`, `New P-256 Qy: ${replacement.qy}`] : [`New demo authenticator: ${input.scheme === "secp256k1" ? input.address : ""}`],
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data } };
    if (input.prepareOnly) return { status: "OWNER_TRANSACTION_REQUIRED", newAuthenticator: replacement ?? input, transaction: intent.transaction };
    if (replacementLabel) {
      // Retain both keys before opening the wallet: cancellation keeps the old key
      // usable, and a submitted transaction can still complete after MCP restarts.
      config.authenticatorLabels ??= {};
      config.authenticatorLabels[current.agentId.toLowerCase()] = [...new Set([replacementLabel,
        ...(config.authenticatorLabels[current.agentId.toLowerCase()] ?? [])])];
      await persistConfig();
    }
    return approveOwnerAction(intent, async () => {
      const updated = await identity(current.agentId);
      const matches = replacement
        ? updated.authenticatorScheme === 2 && updated.p256PublicKey?.qx.toLowerCase() === replacement.qx.toLowerCase() &&
          updated.p256PublicKey?.qy.toLowerCase() === replacement.qy.toLowerCase()
        : input.scheme === "secp256k1" && updated.authenticatorScheme === 1 && updated.authenticator?.toLowerCase() === input.address.toLowerCase();
      if (!matches || updated.authenticationRevoked) throw new ToolError("ROTATION_STATE_MISMATCH", "Confirmed transaction did not activate the expected authenticator");
      return { authenticatorScheme: updated.authenticatorScheme,
        authenticator: updated.authenticator, p256PublicKey: updated.p256PublicKey,
        authenticationRevoked: updated.authenticationRevoked };
    }, replacement
      ? { module: "agentValidator", abi: parseAbiItem("event P256AuthenticatorRotated(address indexed account, bytes32 qx, bytes32 qy)"),
        matches: args => args.qx === replacement.qx.toLowerCase() && args.qy === replacement.qy.toLowerCase() }
      : { module: "agentValidator", abi: parseAbiItem("event AuthenticatorRotated(address indexed account, address indexed authenticator)"),
        matches: args => input.scheme === "secp256k1" && typeof args.authenticator === "string" && args.authenticator.toLowerCase() === input.address.toLowerCase() }, signal);
  }

  server.registerTool("agentic_revoke_authenticator", {
    description: "Open owner-wallet approval to revoke one configured agent authenticator; optionally return a read-only transaction preview.",
    inputSchema: z.object({ agentId: z.string().optional(), prepareOnly: z.boolean().optional() }),
  }, async ({ agentId, prepareOnly }, ctx) => guarded(async () => {
    const current = await identity(selectManagedAgentId(agentId));
    if (current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_ALREADY_REVOKED", "This agent authenticator is already revoked");
    const data = encodeFunctionData({ abi: agentAccountAbi, functionName: "revokeAuthenticator" });
    try { await client.call({ account: current.owner, to: current.agentId, data }); }
    catch { throw new ToolError("REVOCATION_SIMULATION_FAILED", "The current account rejected revocation; check the owner and account state"); }
    const intent: OwnerActionIntent = { action: "revoke", agentId: current.agentId,
      summary: "Revoke this agent's operating authenticator. It will not be able to create new authenticated service sessions.",
      details: ["New authentication proofs will be rejected.", "Existing service sessions may remain usable until expiry or service-side invalidation."],
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data } };
    if (prepareOnly) return { status: "OWNER_TRANSACTION_REQUIRED", agentId: current.agentId, owner: current.owner, transaction: intent.transaction };
    return approveOwnerAction(intent, async () => {
      const updated = await identity(current.agentId);
      if (!updated.authenticationRevoked) throw new ToolError("REVOCATION_STATE_MISMATCH", "Confirmed transaction did not revoke this authenticator");
      return { authenticationRevoked: true };
    }, { module: "agentValidator", abi: parseAbiItem("event AuthenticationRevokedFor(address indexed account)"), matches: () => true }, ctx.mcpReq.signal);
  }));

  async function sessionProof(challenge: AuthenticationChallenge) {
    try { assertAudience(challenge.audience); }
    catch { throw new ToolError("INVALID_CHALLENGE", "Challenge audience must be a canonical HTTPS origin"); }
    if (!/^0x[0-9a-fA-F]{64}$/.test(challenge.nonce) || challenge.chainId !== config.chainId ||
        !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) ||
        challenge.issuedAt > Math.floor(Date.now() / 1000) + 30 ||
        challenge.expiresAt <= Math.floor(Date.now() / 1000) ||
        challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > 300) {
      throw new ToolError("INVALID_CHALLENGE", "Challenge nonce, chain, or validity window is invalid");
    }
    const current = await authenticationState(selectManagedAgentId(challenge.agentId));
    const agentId = current.agentId;
    if (challenge.agentId.toLowerCase() !== agentId.toLowerCase()) {
      throw new ToolError("AGENT_MISMATCH", "Challenge is for a different agent identity");
    }
    if (current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_REVOKED", "Agent authenticator is revoked");
    if (config.signer) {
      if (current.authenticatorScheme !== 2 || !current.p256PublicKey) throw new ToolError("AUTHENTICATOR_MISMATCH", "Agent does not use a P-256 authenticator");
      return signLocalChallenge(await signerForKey(agentId, current.p256PublicKey), challenge);
    } else if (current.authenticatorScheme !== 1 || current.authenticator?.toLowerCase() !== legacySigner?.address.toLowerCase()) {
      throw new ToolError("AUTHENTICATOR_MISMATCH", "Demo signer is not the current authenticator");
    }
    const selectedAgent = createAgentSdk({ agentId, chainId: config.chainId, signDigest: digest => legacySigner!.sign({ hash: digest }) });
    return selectedAgent.answerChallenge(challenge, challenge.audience);
  }

  server.registerTool("agentic_session_proof", {
    description: "Sign a challenge from a resource's AgenticWorld 401. Returns proof fields and ready-to-send headers; retry the same resource with those headers to receive the resource and Agent-Session. Does not send HTTP.",
    inputSchema: z.object({ challenge: z.strictObject({
      agentId: z.string(), audience: z.string(), chainId: z.int().positive(),
      nonce: z.string(), issuedAt: z.int(), expiresAt: z.int(),
    }) }),
  }, async ({ challenge }) => guarded(async () => {
    const proof = await sessionProof(challenge as AuthenticationChallenge);
    return { ...proof, headers: sessionProofHeaders(proof) };
  }));

  return server;
}

// Node resolves the module URL through symlinks, but argv can retain aliases
// such as /var vs /private/var or an npx bin link. Compare canonical paths.
if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => undefined)) {
  const configPath = process.env.AGENTIC_WORLD_CONFIG;
  const key = process.env.AGENTIC_WORLD_OPERATING_KEY as Hex | undefined;
  if (!configPath) {
    process.stderr.write("Set AGENTIC_WORLD_CONFIG in the host environment.\n");
    process.exitCode = 1;
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const server = await createAgenticWorldMcp(config, key, configPath);
    serveStdio(() => server, { onerror: error => process.stderr.write(`${error.message}\n`) });
  }
}
