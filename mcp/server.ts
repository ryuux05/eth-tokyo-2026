import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { concatHex, createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, isAddress, keccak256, parseAbiItem, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { createAgentSdk } from "../sdk/agent.js";
import { isExpectedAgentClone, agentAccountAbi, agentAccountFactoryAbi, agentPolicyAbi, encodePolicy, Decision, type PolicyRule } from "../sdk/core.js";
import { assertAudience, type AuthenticationChallenge } from "../sdk/core.js";
import { ensureSignerPublicKey, signLocalChallenge, signerPublicKey } from "./local-signer.js";
import { runCreationFlow, type CreationIntent } from "./creation-flow.js";
import { runOwnerActionFlow, type OwnerActionIntent } from "./owner-action-flow.js";

type Config = { rpcUrl: string; chainId: number; agentId?: Address; agentIds?: Address[]; factory?: Address; implementation: Address;
  deploymentBlockNumber?: string; deploymentBlockHash?: Hex;
  signer?: { kind: "secure-enclave" | "windows-tpm"; binaryPath: string; label: string } };

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseConfig(value: unknown): Config {
  const schema = z.strictObject({
    rpcUrl: z.url(), chainId: z.int().positive(), agentId: z.string().optional(), agentIds: z.array(z.string()).max(32).optional(), factory: z.string().optional(), implementation: z.string(),
    deploymentBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    deploymentBlockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    signer: z.strictObject({ kind: z.enum(["secure-enclave", "windows-tpm"]), binaryPath: z.string().refine(isAbsolute, "Signer path must be absolute"), label: z.string().min(1).max(128) }).optional(),
  });
  const parsed = schema.parse(value);
  if (parsed.signer && ((parsed.signer.kind === "secure-enclave" && process.platform !== "darwin") ||
      (parsed.signer.kind === "windows-tpm" && process.platform !== "win32"))) throw new Error("Signer kind does not match this host platform");
  if ((parsed.agentId && !isAddress(parsed.agentId)) || parsed.agentIds?.some(id => !isAddress(id)) ||
      (parsed.factory && !isAddress(parsed.factory)) || !isAddress(parsed.implementation)) throw new Error("Invalid account, factory, or implementation address");
  if (!!parsed.deploymentBlockNumber !== !!parsed.deploymentBlockHash) throw new Error("Deployment fingerprint requires both block number and hash");
  const rpc = new URL(parsed.rpcUrl);
  if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname))) throw new Error("RPC must use HTTPS or loopback HTTP");
  return { ...parsed, agentId: parsed.agentId ? getAddress(parsed.agentId) : undefined,
    agentIds: parsed.agentIds?.map(id => getAddress(id)),
    factory: parsed.factory ? getAddress(parsed.factory) : undefined, implementation: getAddress(parsed.implementation),
    deploymentBlockHash: parsed.deploymentBlockHash as Hex | undefined };
}

export async function createAgenticWorldMcp(configValue: unknown, operatingKey?: Hex, configPath?: string) {
  const config = parseConfig(configValue);
  if (!config.signer && !operatingKey) throw new Error("Configure a local P-256 signer or the demo-only operating key");
  if (operatingKey && !/^0x[0-9a-fA-F]{64}$/.test(operatingKey)) throw new Error("Invalid operating key");
  if (config.signer && operatingKey) throw new Error("Do not provide an operating key when a hardware P-256 signer is configured");
  const legacySigner = operatingKey ? privateKeyToAccount(operatingKey) : undefined;
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const agent = legacySigner && config.agentId ? createAgentSdk({ agentId: config.agentId, chainId: config.chainId, signDigest: digest => legacySigner.sign({ hash: digest }) }) : undefined;
  const server = new McpServer({ name: "agentic-world", version: "0.1.0" }, { capabilities: { tools: {} } });
  let creatingIdentity = false;
  let ownerActionInProgress = false;

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

  async function identity(agentId = config.agentId) {
    if (!agentId) throw new ToolError("IDENTITY_NOT_CONFIGURED", "Create an agent identity and configure its address first");
    const actualChain = await client.getChainId();
    if (actualChain !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const code = await client.getBytecode({ address: agentId, blockNumber });
    if (!isExpectedAgentClone(code, config.implementation)) throw new ToolError("IDENTITY_UNAVAILABLE", "Agent is not the pinned ERC-4337 account clone");
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
    return { agentId, chainId: config.chainId, owner, authenticatorScheme: scheme,
      authenticator: scheme === 1 ? authenticator : undefined,
      p256PublicKey: scheme === 2 ? { qx: p256PublicKey[0], qy: p256PublicKey[1] } : undefined,
      authenticationRevoked: revoked,
      createdAt: Number(createdAt), policyHash, policyRevision: policyRevision.toString(), blockNumber: blockNumber.toString() };
  }

  function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
  async function guarded(fn: () => Promise<unknown>) {
    try { return result(await fn()); }
    catch (error) {
      const code = error instanceof ToolError ? error.code : "OPERATION_FAILED";
      // Never serialize transport errors: URLs can contain credentials and upstream messages can echo request data.
      return { ...result({ code, message: error instanceof ToolError ? error.message : "Agentic World operation failed; check server diagnostics" }), isError: true };
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

  server.registerTool("agentic_list_identities", { description: "List locally configured agent IDs and independently verify each pinned onchain account before an owner action.", inputSchema: z.object({}) },
    async () => guarded(async () => {
      const ids = managedAgentIds();
      return { identities: await Promise.all(ids.map(async id => {
        const current = await identity(id);
        return { agentId: current.agentId, owner: current.owner, chainId: current.chainId,
          authenticatorScheme: current.authenticatorScheme, authenticationRevoked: current.authenticationRevoked };
      })) };
    }));

  server.registerTool("agentic_policy_check", {
    description: "Preview current onchain policy for an EVM action. This is not execution authorization; policy is rechecked during execution.",
    inputSchema: z.object({ target: z.string(), valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/), data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/) }),
  }, async ({ target, valueWei, data }) => guarded(async () => {
    if (!isAddress(target)) throw new ToolError("INVALID_ACTION", "Invalid target address");
    if (!config.agentId) throw new ToolError("IDENTITY_NOT_CONFIGURED", "No agent identity is configured");
    const current = await identity();
    const decision = await client.readContract({ address: config.agentId, abi: agentPolicyAbi, functionName: "evaluateAction",
      args: [target, BigInt(valueWei), data as Hex], blockNumber: BigInt(current.blockNumber) });
    return { decision: decision === Decision.ALLOW ? "ALLOW" : decision === Decision.REQUIRE_OWNER_SIGNATURE ? "REQUIRE_OWNER_SIGNATURE" : "DENY",
      policyHash: current.policyHash, policyRevision: current.policyRevision, blockNumber: current.blockNumber, previewOnly: true };
  }));

  async function prepareIdentity(owner: string, salt: Hex, providedKey?: Awaited<ReturnType<typeof signerPublicKey>>) {
    const key = providedKey ?? (config.signer ? await signerPublicKey(config.signer) : undefined);
    if (!config.factory) throw new ToolError("FACTORY_NOT_CONFIGURED", "Configure a trusted factory address");
    if (!isAddress(owner) || getAddress(owner) === zeroAddress) throw new ToolError("INVALID_OWNER", "Expected a human owner wallet address");
    const actualChain = await client.getChainId();
    if (actualChain !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const factoryCode = await client.getBytecode({ address: config.factory });
    if (!factoryCode || factoryCode === "0x") throw new ToolError("FACTORY_UNAVAILABLE", "Trusted factory is not deployed");
    const implementation = await client.readContract({ address: config.factory, abi: agentAccountFactoryAbi, functionName: "implementation" });
    if (implementation.toLowerCase() !== config.implementation.toLowerCase()) throw new ToolError("IMPLEMENTATION_MISMATCH", "Factory implementation differs from the trusted pin");
    const predictedAgent = await client.readContract({ address: config.factory, abi: agentAccountFactoryAbi,
      functionName: "predictAgent", args: [getAddress(owner), salt as Hex] });
    const existingCode = await client.getBytecode({ address: predictedAgent });
    if (existingCode && existingCode !== "0x") throw new ToolError("IDENTITY_ALREADY_EXISTS", "An agent already exists for this owner and salt");
    if (!key && !legacySigner) throw new ToolError("SIGNER_UNAVAILABLE", "No local signer is configured");
    if (key) await requireNativeP256();
    const data = key
      ? encodeFunctionData({ abi: agentAccountFactoryAbi, functionName: "createAgentP256", args: [key.qx, key.qy, salt as Hex] })
      : encodeFunctionData({ abi: agentAccountFactoryAbi, functionName: "createAgent", args: [legacySigner!.address, salt as Hex] });
    return { status: "OWNER_TRANSACTION_REQUIRED", predictedAgent, authenticator: key ?? { scheme: "secp256k1-demo", address: legacySigner!.address },
      transaction: { chainId: config.chainId, from: getAddress(owner), to: config.factory, value: "0", data },
      next: "The human owner must review and send this transaction from the owner wallet, then configure agentId to the deployed address." };
  }

  server.registerTool("agentic_create_identity", {
    description: "Open a local owner-wallet approval page to create a P-256 agent identity. With explicit owner and salt, only prepare transaction data for a manual flow.",
    inputSchema: z.object({ owner: z.string().optional(), salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }),
  }, async ({ owner, salt }) => guarded(async () => {
    if (owner || salt) {
      if (!owner || !salt) throw new ToolError("INVALID_CREATION_INPUT", "Provide both owner and salt, or neither for browser approval");
      return prepareIdentity(owner, salt as Hex);
    }
    if (!config.signer) throw new ToolError("P256_SIGNER_REQUIRED", "Browser creation requires a local hardware P-256 signer");
    if (!config.factory) throw new ToolError("FACTORY_NOT_CONFIGURED", "Configure a trusted factory address");
    if (config.agentId) throw new ToolError("IDENTITY_ALREADY_CONFIGURED", "An agent identity is already configured");
    if (creatingIdentity) throw new ToolError("CREATION_IN_PROGRESS", "An identity creation page is already open");
    creatingIdentity = true;
    try {
    if (await client.getChainId() !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const factoryCode = await client.getBytecode({ address: config.factory });
    if (!factoryCode || factoryCode === "0x") throw new ToolError("FACTORY_UNAVAILABLE", "Trusted factory is not deployed");
    const implementation = await client.readContract({ address: config.factory, abi: agentAccountFactoryAbi, functionName: "implementation" });
    if (implementation.toLowerCase() !== config.implementation.toLowerCase()) throw new ToolError("IMPLEMENTATION_MISMATCH", "Factory implementation differs from the trusted pin");
    await requireNativeP256();
    const key = await ensureSignerPublicKey(config.signer);
    const creationSalt = `0x${randomBytes(32).toString("hex")}` as Hex;
    let selected: CreationIntent | undefined;
    const agentId = await runCreationFlow({ chainId: config.chainId, factory: config.factory, rpcUrl: config.rpcUrl, qx: key.qx, qy: key.qy,
      deploymentBlockNumber: config.deploymentBlockNumber, deploymentBlockHash: config.deploymentBlockHash,
      prepare: async walletOwner => {
        const prepared = await prepareIdentity(walletOwner, creationSalt, key);
        selected = prepared;
        return prepared;
      },
      confirm: async (hash, intent) => {
        if (!selected || selected !== intent) throw new ToolError("INVALID_FLOW", "Owner transaction was not prepared by this flow");
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== "success") throw new ToolError("TRANSACTION_REVERTED", "Owner transaction reverted");
        const transaction = await client.getTransaction({ hash });
        if (transaction.from.toLowerCase() !== intent.transaction.from.toLowerCase() ||
            transaction.to?.toLowerCase() !== intent.transaction.to.toLowerCase() ||
            transaction.input.toLowerCase() !== intent.transaction.data.toLowerCase() || transaction.value !== 0n) {
          throw new ToolError("TRANSACTION_MISMATCH", "Confirmed transaction does not match the owner creation intent");
        }
        const event = parseAbiItem("event AgentCreatedP256(address indexed agent,address indexed owner,bytes32 qx,bytes32 qy)");
        const created = receipt.logs.some(log => {
          if (log.address.toLowerCase() !== config.factory?.toLowerCase()) return false;
          try {
            const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
            return decoded.args.agent.toLowerCase() === intent.predictedAgent.toLowerCase() &&
              decoded.args.owner.toLowerCase() === intent.transaction.from.toLowerCase() &&
              decoded.args.qx.toLowerCase() === key.qx.toLowerCase() && decoded.args.qy.toLowerCase() === key.qy.toLowerCase();
          } catch { return false; }
        });
        if (!created) throw new ToolError("CREATION_EVENT_MISSING", "Factory did not emit the expected agent creation event");
        const code = await client.getBytecode({ address: intent.predictedAgent });
        if (!isExpectedAgentClone(code, config.implementation)) throw new ToolError("IDENTITY_UNAVAILABLE", "Created agent is not the pinned account clone");
        const [chainOwner, publicKey, scheme] = await Promise.all([
          client.readContract({ address: intent.predictedAgent, abi: agentAccountAbi, functionName: "owner" }),
          client.readContract({ address: intent.predictedAgent, abi: agentAccountAbi, functionName: "authenticatorP256" }),
          client.readContract({ address: intent.predictedAgent, abi: agentAccountAbi, functionName: "authenticatorScheme" }),
        ]);
        if (chainOwner.toLowerCase() !== intent.transaction.from.toLowerCase() || scheme !== 2 ||
            publicKey[0].toLowerCase() !== key.qx.toLowerCase() || publicKey[1].toLowerCase() !== key.qy.toLowerCase()) {
          throw new ToolError("IDENTITY_MISMATCH", "Onchain owner or authenticator does not match the approved identity");
        }
        config.agentIds = [...new Map([...managedAgentIds(), intent.predictedAgent]
          .map(id => [id.toLowerCase(), id] as const)).values()];
        config.agentId = intent.predictedAgent;
        if (configPath) {
          const temp = `${configPath}.${randomBytes(4).toString("hex")}.tmp`;
          await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
          await rename(temp, configPath);
        }
        return intent.predictedAgent;
      },
    });
    return { status: "IDENTITY_CREATED", agentId, owner: selected?.transaction.from, chainId: config.chainId,
      next: "The onchain identity is confirmed and the local MCP config has been updated." };
    } finally { creatingIdentity = false; }
  }));

  const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

  async function approveOwnerAction<T>(intent: OwnerActionIntent, verifyState: () => Promise<T>) {
    if (ownerActionInProgress) throw new ToolError("OWNER_ACTION_IN_PROGRESS", "An owner approval page is already open");
    ownerActionInProgress = true;
    try {
      const confirmed = await runOwnerActionFlow({ intent, rpcUrl: config.rpcUrl,
        deploymentBlockNumber: config.deploymentBlockNumber, deploymentBlockHash: config.deploymentBlockHash,
        confirm: async hash => {
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
          if (receipt.status !== "success") throw new ToolError("TRANSACTION_REVERTED", "Owner transaction reverted");
          const transaction = await client.getTransaction({ hash });
          if (transaction.from.toLowerCase() !== intent.transaction.from.toLowerCase() ||
              transaction.to?.toLowerCase() !== intent.transaction.to.toLowerCase() ||
              transaction.input.toLowerCase() !== intent.transaction.data.toLowerCase() || transaction.value !== 0n ||
              (await client.getChainId()) !== intent.transaction.chainId) {
            throw new ToolError("TRANSACTION_MISMATCH", "Confirmed transaction does not match the prepared owner action");
          }
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
  }, async ({ agentId, rules, prepareOnly }) => guarded(async () => {
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
    });
  }));

  server.registerTool("agentic_rotate_authenticator", {
    description: "Open owner-wallet approval to rotate an authenticator; optionally return a read-only transaction preview.",
    inputSchema: z.discriminatedUnion("scheme", [
      z.strictObject({ scheme: z.literal("p256"), agentId: z.string().optional(), prepareOnly: z.boolean().optional(), qx: z.string().regex(/^0x[0-9a-fA-F]{64}$/), qy: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      z.strictObject({ scheme: z.literal("secp256k1"), agentId: z.string().optional(), prepareOnly: z.boolean().optional(), address: z.string() }),
    ]),
  }, async input => guarded(async () => {
    const current = await identity(selectManagedAgentId(input.agentId));
    if (current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_REVOKED", "A revoked authenticator must be restored by a separate owner action");
    let data: Hex;
    if (input.scheme === "p256") {
      await requireNativeP256();
      if (current.p256PublicKey?.qx.toLowerCase() === input.qx.toLowerCase() &&
          current.p256PublicKey?.qy.toLowerCase() === input.qy.toLowerCase()) throw new ToolError("AUTHENTICATOR_UNCHANGED", "That P-256 key is already active");
      data = encodeFunctionData({ abi: agentAccountAbi, functionName: "rotateP256Authenticator", args: [input.qx as Hex, input.qy as Hex] });
    } else {
      if (!isAddress(input.address) || getAddress(input.address) === zeroAddress ||
          input.address.toLowerCase() === current.owner.toLowerCase() || input.address.toLowerCase() === current.agentId.toLowerCase()) {
        throw new ToolError("INVALID_AUTHENTICATOR", "Invalid operating address");
      }
      data = encodeFunctionData({ abi: agentAccountAbi, functionName: "rotateAuthenticator", args: [getAddress(input.address)] });
    }
    try { await client.call({ account: current.owner, to: current.agentId, data }); }
    catch { throw new ToolError("ROTATION_SIMULATION_FAILED", "The current account rejected this rotation; check the new key and owner state"); }
    const intent: OwnerActionIntent = { action: "rotate", agentId: current.agentId,
      summary: "Replace this agent's operating authenticator. Existing service sessions may remain valid until they expire.",
      details: input.scheme === "p256" ? [`New P-256 Qx: ${input.qx}`, `New P-256 Qy: ${input.qy}`] : [`New demo authenticator: ${input.address}`],
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data } };
    if (input.prepareOnly) return { status: "OWNER_TRANSACTION_REQUIRED", newAuthenticator: input, transaction: intent.transaction };
    return approveOwnerAction(intent, async () => {
      const updated = await identity(current.agentId);
      const matches = input.scheme === "p256"
        ? updated.authenticatorScheme === 2 && updated.p256PublicKey?.qx.toLowerCase() === input.qx.toLowerCase() &&
          updated.p256PublicKey?.qy.toLowerCase() === input.qy.toLowerCase()
        : updated.authenticatorScheme === 1 && updated.authenticator?.toLowerCase() === input.address.toLowerCase();
      if (!matches || updated.authenticationRevoked) throw new ToolError("ROTATION_STATE_MISMATCH", "Confirmed transaction did not activate the expected authenticator");
      return { authenticatorScheme: updated.authenticatorScheme,
        authenticator: updated.authenticator, p256PublicKey: updated.p256PublicKey,
        authenticationRevoked: updated.authenticationRevoked };
    });
  }));

  server.registerTool("agentic_revoke_authenticator", {
    description: "Open owner-wallet approval to revoke one configured agent authenticator; optionally return a read-only transaction preview.",
    inputSchema: z.object({ agentId: z.string().optional(), prepareOnly: z.boolean().optional() }),
  }, async ({ agentId, prepareOnly }) => guarded(async () => {
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
    });
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
    const current = await identity();
    const agentId = current.agentId;
    if (challenge.agentId.toLowerCase() !== agentId.toLowerCase()) {
      throw new ToolError("AGENT_MISMATCH", "Challenge is for a different agent identity");
    }
    if (current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_REVOKED", "Agent authenticator is revoked");
    if (config.signer) {
      if (current.authenticatorScheme !== 2 || !current.p256PublicKey) throw new ToolError("AUTHENTICATOR_MISMATCH", "Agent does not use a P-256 authenticator");
      const key = await signerPublicKey(config.signer);
      if (key.qx.toLowerCase() !== current.p256PublicKey.qx.toLowerCase() || key.qy.toLowerCase() !== current.p256PublicKey.qy.toLowerCase()) {
        throw new ToolError("AUTHENTICATOR_MISMATCH", "Local hardware P-256 key is not the current authenticator");
      }
      return signLocalChallenge(config.signer, challenge);
    } else if (current.authenticatorScheme !== 1 || current.authenticator?.toLowerCase() !== legacySigner?.address.toLowerCase()) {
      throw new ToolError("AUTHENTICATOR_MISMATCH", "Demo signer is not the current authenticator");
    }
    return agent!.answerChallenge(challenge, challenge.audience);
  }

  server.registerTool("agentic_session_proof", {
    description: "Sign one service-issued AgentAuthentication challenge. Returns a proof; the agent sends it to the service and receives the service-owned session.",
    inputSchema: z.object({ challenge: z.strictObject({
      agentId: z.string(), audience: z.string(), chainId: z.int().positive(),
      nonce: z.string(), issuedAt: z.int(), expiresAt: z.int(),
    }) }),
  }, async ({ challenge }) => guarded(() => sessionProof(challenge as AuthenticationChallenge)));

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
