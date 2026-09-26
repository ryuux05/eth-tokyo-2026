import { readFile } from "node:fs/promises";
import { createPublicClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { createAgentSdk, requestProofHeaders } from "../sdk/agent.js";
import { isExpectedAgentClone, agentAccountAbi, agentPolicyAbi, Decision } from "../sdk/core.js";
import { signLocalRequest, signerPublicKey } from "./local-signer.js";

type Service = { baseUrl: string; audience: string; methods: string[]; paths: string[] };
type Config = { rpcUrl: string; chainId: number; agentId: Address; implementation: Address;
  signer?: { kind: "secure-enclave"; binaryPath: string; label: string }; services: Record<string, Service> };
type Session = { token: string; expiresAt: number };

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseConfig(value: unknown): Config {
  const schema = z.strictObject({
    rpcUrl: z.url(), chainId: z.int().positive(), agentId: z.string(), implementation: z.string(),
    signer: z.strictObject({ kind: z.literal("secure-enclave"), binaryPath: z.string().startsWith("/"), label: z.string().min(1).max(128) }).optional(),
    // Optional loopback transport aliases exist only for the local HTTP demo.
    services: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.strictObject({
      baseUrl: z.url(), audience: z.url(), methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])).min(1),
      paths: z.array(z.string().startsWith("/")).min(1),
    })).optional().default({}),
  });
  const parsed = schema.parse(value);
  if (!isAddress(parsed.agentId) || !isAddress(parsed.implementation)) throw new Error("Invalid account or implementation address");
  const rpc = new URL(parsed.rpcUrl);
  if (rpc.protocol !== "https:" && !(rpc.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname))) throw new Error("RPC must use HTTPS or loopback HTTP");
  for (const [name, service] of Object.entries(parsed.services)) {
    const base = new URL(service.baseUrl);
    const audience = new URL(service.audience);
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error(`Invalid base URL for ${name}`);
    if (audience.origin !== service.audience || audience.pathname !== "/" || audience.search || audience.hash || audience.username || audience.password) throw new Error(`Invalid audience for ${name}`);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error(`Service ${name} must use HTTPS or loopback HTTP`);
    // A local demo can use a public HTTPS audience while binding its HTTP listener to loopback.
    if (base.protocol === "https:" && base.origin !== service.audience) throw new Error(`Audience and base URL mismatch for ${name}`);
    for (const path of service.paths) if (path.startsWith("//") || path.includes("?") || path.includes("#") || path.includes("..")) throw new Error(`Invalid allowlisted path for ${name}`);
  }
  return { ...parsed, agentId: getAddress(parsed.agentId), implementation: getAddress(parsed.implementation) };
}

export async function createAgenticWorldMcp(configValue: unknown, operatingKey?: Hex) {
  const config = parseConfig(configValue);
  if (!config.signer && !operatingKey) throw new Error("Configure a Secure Enclave signer or the demo-only operating key");
  if (operatingKey && !/^0x[0-9a-fA-F]{64}$/.test(operatingKey)) throw new Error("Invalid operating key");
  if (config.signer && operatingKey) throw new Error("Do not provide an operating key when a Secure Enclave signer is configured");
  const legacySigner = operatingKey ? privateKeyToAccount(operatingKey) : undefined;
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const agent = legacySigner ? createAgentSdk({ agentId: config.agentId, chainId: config.chainId, signDigest: digest => legacySigner.sign({ hash: digest }) }) : undefined;
  const sessions = new Map<string, Session>();
  const server = new McpServer({ name: "agentic-world", version: "0.1.0" }, { capabilities: { tools: {} } });

  async function identity() {
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
    async () => guarded(identity));

  server.registerTool("agentic_policy_check", {
    description: "Preview current onchain policy for an EVM action. This is not execution authorization; policy is rechecked during execution.",
    inputSchema: z.object({ target: z.string(), valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/), data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/) }),
  }, async ({ target, valueWei, data }) => guarded(async () => {
    if (!isAddress(target)) throw new ToolError("INVALID_ACTION", "Invalid target address");
    const current = await identity();
    const decision = await client.readContract({ address: config.agentId, abi: agentPolicyAbi, functionName: "evaluateAction",
      args: [target, BigInt(valueWei), data as Hex], blockNumber: BigInt(current.blockNumber) });
    return { decision: decision === Decision.ALLOW ? "ALLOW" : decision === Decision.REQUIRE_OWNER_SIGNATURE ? "REQUIRE_OWNER_SIGNATURE" : "DENY",
      policyHash: current.policyHash, policyRevision: current.policyRevision, blockNumber: current.blockNumber, previewOnly: true };
  }));

  server.registerTool("agentic_request", {
    description: "Call an HTTPS service as the configured agent. The URL determines audience and exact resource; authentication and session are managed internally. The service decides authorization.",
    inputSchema: z.object({ url: z.url(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), body: z.string().optional() }),
  }, async ({ url: rawUrl, method, body }) => guarded(async () => {
    if (method === "GET" && body !== undefined) throw new ToolError("INVALID_BODY", "GET requests cannot include a body");
    if (body && Buffer.byteLength(body) > 64 * 1024) throw new ToolError("BODY_TOO_LARGE", "Request body exceeds 64 KiB");
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
      throw new ToolError("INVALID_URL", "Request URL must be HTTPS without credentials or fragment");
    }
    const audience = parsedUrl.origin;
    const target = `${parsedUrl.pathname}${parsedUrl.search}`;
    const demoEndpoint = Object.values(config.services).find(service => service.audience === audience);
    const transportUrl = demoEndpoint ? new URL(target, demoEndpoint.baseUrl) : parsedUrl;
    if (demoEndpoint && (!demoEndpoint.methods.includes(method) || !demoEndpoint.paths.includes(parsedUrl.pathname))) {
      throw new ToolError("REQUEST_NOT_ALLOWED", "Local demo transport does not expose this route");
    }
    const current = await identity();
    if (current.authenticationRevoked) throw new ToolError("AUTHENTICATOR_REVOKED", "Agent authenticator is revoked");
    if (config.signer) {
      if (current.authenticatorScheme !== 2 || !current.p256PublicKey) throw new ToolError("AUTHENTICATOR_MISMATCH", "Agent does not use a P-256 authenticator");
      const key = await signerPublicKey(config.signer);
      if (key.qx.toLowerCase() !== current.p256PublicKey.qx.toLowerCase() || key.qy.toLowerCase() !== current.p256PublicKey.qy.toLowerCase()) {
        throw new ToolError("AUTHENTICATOR_MISMATCH", "Local Secure Enclave key is not the current authenticator");
      }
    } else if (current.authenticatorScheme !== 1 || current.authenticator?.toLowerCase() !== legacySigner?.address.toLowerCase()) {
      throw new ToolError("AUTHENTICATOR_MISMATCH", "Demo signer is not the current authenticator");
    }
    const bytes = new TextEncoder().encode(body ?? "");
    const cached = sessions.get(audience);
    const useSession = cached && cached.expiresAt > Date.now();
    const send = async (sessionToken?: string) => {
      const proof = sessionToken ? undefined : config.signer
        ? await signLocalRequest(config.signer, { agentId: config.agentId, chainId: config.chainId }, { audience, method, target, body: bytes })
        : await agent!.signRequest({ method, target, body: bytes }, audience);
      const response = await fetch(transportUrl, {
        method, redirect: "manual", signal: AbortSignal.timeout(15_000), body: method === "GET" ? undefined : bytes,
        headers: { ...(sessionToken ? { "Agent-Session": sessionToken } : requestProofHeaders(proof!)), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      });
      return response;
    };
    let response = await send(useSession ? cached.token : undefined);
    if (useSession && response.status === 401) { sessions.delete(audience); response = await send(); }
    const token = response.headers.get("Agent-Session");
    if (token && response.ok && token.length <= 512 && /^[\x21-\x7e]+$/.test(token)) sessions.set(audience, { token, expiresAt: Date.now() + 45_000 });
    if (response.status === 401) sessions.delete(audience);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 64 * 1024) { await response.body?.cancel(); throw new ToolError("RESPONSE_TOO_LARGE", "Service response exceeds 64 KiB"); }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw new ToolError("RESPONSE_TOO_LARGE", "Service response exceeds 64 KiB"); }
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return { status: response.status, body: text, contentType: response.headers.get("content-type"), authenticatedAs: config.agentId,
      audience, usedSession: !!useSession, sessionEstablished: !!token && response.ok };
  }));

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
