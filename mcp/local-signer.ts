import { spawn } from "node:child_process";
import { keccak256, type Address, type Hex } from "viem";
import { authenticationDigest, requestAuthenticationDigest, type AuthenticationChallenge, type AuthenticationProof, type RequestAuthenticationProof } from "../sdk/core.js";

type SignerConfig = { binaryPath: string; label: string };
type PublicKey = { scheme: "p256"; qx: Hex; qy: Hex };

async function invoke(config: SignerConfig, command: "provision" | "public-key" | "sign-request" | "sign-challenge", input?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env = process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH }
      : { PATH: "/usr/bin:/bin" };
    const child = spawn(config.binaryPath, [command, config.label], { stdio: ["pipe", "pipe", "pipe"], env });
    const stdout: Buffer[] = [];
    let outputSize = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Local signer timed out")); }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 4096) { child.kill("SIGKILL"); return; }
      stdout.push(chunk);
    });
    child.stderr.resume(); // The helper never receives secrets in argv and its diagnostics are not sent to the model.
    child.stdin.on("error", error => { clearTimeout(timer); reject(error); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || outputSize > 4096) { reject(new Error("Local signer failed")); return; }
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch { reject(new Error("Invalid local signer response")); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export async function signerPublicKey(config: SignerConfig): Promise<PublicKey> {
  const value = await invoke(config, "public-key") as Record<string, unknown>;
  if (value.scheme !== "p256" || typeof value.qx !== "string" || typeof value.qy !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.qx) || !/^0x[0-9a-fA-F]{64}$/.test(value.qy)) throw new Error("Invalid signer public key");
  return value as PublicKey;
}

/** Called only for an explicit identity-creation request; never during MCP startup. */
export async function ensureSignerPublicKey(config: SignerConfig): Promise<PublicKey> {
  try { return await signerPublicKey(config); }
  catch {
    // Both hardware helpers refuse to overwrite an existing label. If another process
    // provisioned it meanwhile, reading the key again is safe.
    try { await invoke(config, "provision"); }
    catch { return signerPublicKey(config); }
    return signerPublicKey(config);
  }
}

export async function signLocalChallenge(config: SignerConfig, challenge: AuthenticationChallenge): Promise<AuthenticationProof> {
  const value = await invoke(config, "sign-challenge", { kind: "AgentAuthentication", label: config.label, challenge }) as Record<string, unknown>;
  const proof = value as AuthenticationProof;
  const now = Math.floor(Date.now() / 1000);
  if (proof.agentId?.toLowerCase() !== challenge.agentId.toLowerCase() ||
      proof.audience !== challenge.audience || proof.chainId !== challenge.chainId ||
      proof.nonce !== challenge.nonce || proof.issuedAt !== challenge.issuedAt ||
      proof.expiresAt !== challenge.expiresAt || proof.issuedAt > now + 30 ||
      proof.expiresAt <= now || !/^0x[0-9a-fA-F]{128}$/.test(proof.signature)) {
    throw new Error("Local signer returned a mismatched challenge proof");
  }
  authenticationDigest(proof);
  return proof;
}

export async function signLocalRequest(config: SignerConfig, identity: { agentId: Address; chainId: number },
  request: { audience: string; method: string; target: string; body: Uint8Array }): Promise<RequestAuthenticationProof> {
  const value = await invoke(config, "sign-request", {
    kind: "AgentRequest", label: config.label, agentId: identity.agentId, chainId: identity.chainId,
    audience: request.audience, method: request.method, target: request.target,
    bodyBase64: Buffer.from(request.body).toString("base64"),
  }) as Record<string, unknown>;
  const proof = value as RequestAuthenticationProof;
  const now = Math.floor(Date.now() / 1000);
  if (proof.agentId?.toLowerCase() !== identity.agentId.toLowerCase() || proof.chainId !== identity.chainId ||
      proof.audience !== request.audience || proof.method !== request.method || proof.target !== request.target ||
      proof.bodyHash !== keccak256(request.body) || !/^0x[0-9a-fA-F]{64}$/.test(proof.nonce) ||
      !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt) ||
      proof.issuedAt > now + 30 || proof.issuedAt < now - 60 || proof.expiresAt !== proof.issuedAt + 60 ||
      proof.expiresAt <= now || !/^0x[0-9a-fA-F]{128}$/.test(proof.signature)) {
    throw new Error("Local signer returned a mismatched request proof");
  }
  requestAuthenticationDigest(proof); // Also reject malformed typed-data fields before sending a request.
  return proof;
}
