import { readFile } from "node:fs/promises";
import { concatHex, createPublicClient, encodeFunctionData, getAddress, http, isAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { createAgentSdk } from "../sdk/agent.js";
import { isExpectedAgentClone, agentAccountAbi, agentAccountFactoryAbi, agentPolicyAbi, encodePolicy, Decision, type PolicyRule } from "../sdk/core.js";
import { assertAudience, type AuthenticationChallenge } from "../sdk/core.js";
import { signLocalChallenge, signerPublicKey } from "./local-signer.js";

type Config = { rpcUrl: string; chainId: number; agentId?: Address; factory?: Address; implementation: Address;
  signer?: { kind: "secure-enclave"; binaryPath: string; label: string } };

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseConfig(value: unknown): Config {
  const schema = z.strictObject({
    rpcUrl: z.url(), chainId: z.int().positive(), agentId: z.string().optional(), factory: z.string().optional(), implementation: z.string(),
    signer: z.strictObject({ kind: z.literal("secure-enclave"), binaryPath: z.string().startsWith("/"), label: z.string().min(1).max(128) }).optional(),
  });
  const parsed = schema.parse(value);
  if ((parsed.agentId && !isAddress(parsed.agentId)) || (parsed.factory && !isAddress(parsed.factory)) || !isAddress(parsed.implementation)) throw new Error("Invalid account, factory, or implementation address");
  const rpc = new URL(parsed.rpcUrl);
  if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname))) throw new Error("RPC must use HTTPS or loopback HTTP");
  return { ...parsed, agentId: parsed.agentId ? getAddress(parsed.agentId) : undefined,
    factory: parsed.factory ? getAddress(parsed.factory) : undefined, implementation: getAddress(parsed.implementation) };
}

export async function createAgenticWorldMcp(configValue: unknown, operatingKey?: Hex) {
  const config = parseConfig(configValue);
  if (!config.signer && !operatingKey) throw new Error("Configure a Secure Enclave signer or the demo-only operating key");
  if (operatingKey && !/^0x[0-9a-fA-F]{64}$/.test(operatingKey)) throw new Error("Invalid operating key");
  if (config.signer && operatingKey) throw new Error("Do not provide an operating key when a Secure Enclave signer is configured");
  const legacySigner = operatingKey ? privateKeyToAccount(operatingKey) : undefined;
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const agent = legacySigner && config.agentId ? createAgentSdk({ agentId: config.agentId, chainId: config.chainId, signDigest: digest => legacySigner.sign({ hash: digest }) }) : undefined;
  const server = new McpServer({ name: "agentic-world", version: "0.1.0" }, { capabilities: { tools: {} } });

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

  async function identity() {
    if (!config.agentId) throw new ToolError("IDENTITY_NOT_CONFIGURED", "Create an agent identity and configure its address first");
    const actualChain = await client.getChainId();
    if (actualChain !== config.chainId) throw new ToolError("CHAIN_MISMATCH", "RPC chain does not match configured chainId");
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const code = await client.getBytecode({ address: config.agentId, blockNumber });
    if (!isExpectedAgentClone(code, config.implementation)) throw new ToolError("IDENTITY_UNAVAILABLE", "Agent is not the pinned ERC-4337 account clone");
    const [owner, authenticator, scheme, p256PublicKey, revoked, createdAt, policyHash, policyRevision] = await Promise.all([
      client.readContract({ address: config.agentId, abi: agentAccountAbi, functionName: "owner", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentAccountAbi, functionName: "authenticator", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentAccountAbi, functionName: "authenticatorScheme", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentAccountAbi, functionName: "authenticatorP256", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentAccountAbi, functionName: "authenticationRevoked", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentAccountAbi, functionName: "createdAt", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentPolicyAbi, functionName: "policyHash", blockNumber }),
      client.readContract({ address: config.agentId, abi: agentPolicyAbi, functionName: "policyRevision", blockNumber }),
    ]);
    return { agentId: config.agentId, chainId: config.chainId, owner, authenticatorScheme: scheme,
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

  server.registerTool("agentic_create_identity", {
    description: "Prepare, but never submit, a factory transaction for the human owner to create a P-256 agent identity. Requires a provisioned local signer and trusted factory configuration.",
    inputSchema: z.object({ owner: z.string(), salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  }, async ({ owner, salt }) => guarded(async () => {
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
    const key = config.signer ? await signerPublicKey(config.signer) : undefined;
    if (!key && !legacySigner) throw new ToolError("SIGNER_UNAVAILABLE", "No local signer is configured");
    if (key) await requireNativeP256();
    const data = key
      ? encodeFunctionData({ abi: agentAccountFactoryAbi, functionName: "createAgentP256", args: [key.qx, key.qy, salt as Hex] })
      : encodeFunctionData({ abi: agentAccountFactoryAbi, functionName: "createAgent", args: [legacySigner!.address, salt as Hex] });
    return { status: "OWNER_TRANSACTION_REQUIRED", predictedAgent, authenticator: key ?? { scheme: "secp256k1-demo", address: legacySigner!.address },
      transaction: { chainId: config.chainId, from: getAddress(owner), to: config.factory, value: "0", data },
      next: "The human owner must review and send this transaction from the owner wallet, then configure agentId to the deployed address." };
  }));

  const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
  server.registerTool("agentic_set_policy", {
    description: "Validate and prepare an owner-only setPolicy transaction. This tool never signs or submits it.",
    inputSchema: z.object({ rules: z.array(z.strictObject({
      target: z.string(), selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/), token: z.string(),
      maxValueWei: decimal, maxAmount: decimal, decision: z.enum(["DENY", "ALLOW", "REQUIRE_OWNER_SIGNATURE"]),
    })).max(32) }),
  }, async ({ rules }) => guarded(async () => {
    const current = await identity();
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
    return { status: "OWNER_TRANSACTION_REQUIRED", policyHash, ruleCount: parsed.length,
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data },
      next: "The human owner must review the rules and send this transaction from the owner wallet. The agent cannot approve it." };
  }));

  server.registerTool("agentic_rotate_authenticator", {
    description: "Prepare an owner-only authenticator rotation to new P-256 coordinates or a legacy demo address. This tool never signs or submits it.",
    inputSchema: z.discriminatedUnion("scheme", [
      z.strictObject({ scheme: z.literal("p256"), qx: z.string().regex(/^0x[0-9a-fA-F]{64}$/), qy: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      z.strictObject({ scheme: z.literal("secp256k1"), address: z.string() }),
    ]),
  }, async input => guarded(async () => {
    const current = await identity();
    if (current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_REVOKED", "A revoked authenticator must be restored by a separate owner action");
    let data: Hex;
    if (input.scheme === "p256") {
      await requireNativeP256();
      if (current.p256PublicKey?.qx.toLowerCase() === input.qx.toLowerCase() &&
          current.p256PublicKey?.qy.toLowerCase() === input.qy.toLowerCase()) throw new ToolError("AUTHENTICATOR_UNCHANGED", "That P-256 key is already active");
      data = encodeFunctionData({ abi: agentAccountAbi, functionName: "rotateP256Authenticator", args: [input.qx as Hex, input.qy as Hex] });
    } else {
      if (!isAddress(input.address) || getAddress(input.address) === zeroAddress ||
          input.address.toLowerCase() === current.owner.toLowerCase() || input.address.toLowerCase() === config.agentId?.toLowerCase()) {
        throw new ToolError("INVALID_AUTHENTICATOR", "Invalid operating address");
      }
      data = encodeFunctionData({ abi: agentAccountAbi, functionName: "rotateAuthenticator", args: [getAddress(input.address)] });
    }
    try { await client.call({ account: current.owner, to: current.agentId, data }); }
    catch { throw new ToolError("ROTATION_SIMULATION_FAILED", "The current account rejected this rotation; check the new key and owner state"); }
    return { status: "OWNER_TRANSACTION_REQUIRED", newAuthenticator: input,
      transaction: { chainId: config.chainId, from: current.owner, to: current.agentId, value: "0", data },
      next: "The human owner must review and send this transaction. Update the local signer config after confirmation; existing sessions may remain valid until expiry." };
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
        throw new ToolError("AUTHENTICATOR_MISMATCH", "Local Secure Enclave key is not the current authenticator");
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const configPath = process.env.AGENTIC_WORLD_CONFIG;
  const key = process.env.AGENTIC_WORLD_OPERATING_KEY as Hex | undefined;
  if (!configPath) {
    process.stderr.write("Set AGENTIC_WORLD_CONFIG in the host environment.\n");
    process.exitCode = 1;
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const server = await createAgenticWorldMcp(config, key);
    serveStdio(() => server, { onerror: error => process.stderr.write(`${error.message}\n`) });
  }
}
