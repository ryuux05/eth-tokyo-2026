import type { IncomingMessage, ServerResponse } from "node:http";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { assertAudience, type AuthenticationChallenge, type AuthenticationProof } from "./core.js";
import { AgentAuthenticationError, AgentAuthorizationError } from "./errors.js";
import type { Session } from "./service.js";

export type AgenticAuthentication<User> = { session: Session; user: User };
export type AgenticRequest<User> = IncomingMessage & { agentic?: AgenticAuthentication<User> };
export type AgenticMiddlewareOptions<User> = {
  realm?: string;
  /** Service-owned permission check, evaluated for every resource request. */
  authorize: (authentication: AgenticAuthentication<User>, request: IncomingMessage) => boolean | Promise<boolean>;
};
export type AgenticMiddleware<User> = (
  request: AgenticRequest<User>, response: ServerResponse, next: () => void | Promise<void>,
) => Promise<void>;

/** Node HTTP / Express-compatible resource middleware. Mount only on routes
 * offering Agentic World, after any public/human-auth fallback. It never wraps
 * arbitrary 401 responses. Challenges and proofs use the resource route itself. */
export function createAgenticWorldMiddleware<User>(
  service: {
    readSession: (token: string) => Promise<{ session: Session; user: User | null } | undefined>;
    createChallenge: (agentId: Address) => Promise<AuthenticationChallenge>;
    authenticate: (proof: AuthenticationProof, authorizeResource: (auth: AgenticAuthentication<User>) => boolean | Promise<boolean>) =>
      Promise<{ token: string; session: Session; user: User | null }>;
  },
  audience: string,
  options: AgenticMiddlewareOptions<User>,
): AgenticMiddleware<User> {
  assertAudience(audience);
  if (typeof options.authorize !== "function") throw new Error("Provide a service-owned resource authorization callback");
  const realm = options.realm ?? "Agentic World";
  if (/[\x00-\x1f\x7f]/.test(realm)) throw new Error("Invalid authentication realm");
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const offer = `AgenticWorld realm=${quote(realm)}, audience=${quote(audience)}, transport="resource"`;
  const authorize = options.authorize;
  return async (request, response, next) => {
    delete request.agentic;
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
      response.end(JSON.stringify(value));
    };
    try {
      // Reject duplicates before Node's normalized headers can join them.
      const seen = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const key = request.rawHeaders[i].toLowerCase();
        if (!key.startsWith("agent-")) continue;
        if (seen.has(key)) throw new InvalidHeaders();
        seen.add(key);
      }
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        if (value !== undefined && (typeof value !== "string" || value.length > 1024)) throw new InvalidHeaders();
        return value;
      };
      const token = header("agent-session");
      const agentId = header("agent-id");
      if (agentId !== undefined && (!isAddress(agentId) || agentId.toLowerCase() === zeroAddress)) throw new InvalidHeaders();
      const proofFields = ["agent-audience", "agent-chain-id", "agent-nonce", "agent-issued-at", "agent-expires-at", "agent-signature"];
      const hasProof = proofFields.some(name => header(name) !== undefined);
      if (token !== undefined && hasProof) throw new InvalidHeaders();
      let authentication: { session: Session; user: User | null } | undefined;
      let newToken: string | undefined;
      if (hasProof) {
        if (!agentId || proofFields.some(name => !header(name))) throw new InvalidHeaders();
        const integer = (name: string) => {
          const value = header(name)!;
          if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidHeaders();
          return Number(value);
        };
        const proof: AuthenticationProof = { agentId: agentId as Address, audience: header("agent-audience")!,
          chainId: integer("agent-chain-id"), nonce: header("agent-nonce")! as Hex,
          issuedAt: integer("agent-issued-at"), expiresAt: integer("agent-expires-at"), signature: header("agent-signature")! as Hex };
        const result = await service.authenticate(proof, auth => authorize(auth, request));
        authentication = result;
        newToken = result.token;
      } else {
        authentication = token === undefined ? undefined : await service.readSession(token);
      }
      if (!authentication) {
        const challenge = agentId ? await service.createChallenge(agentId as Address) : undefined;
        send(401, { error: challenge ? "Sign this challenge and retry this resource" : "An Agent-ID or valid Agent-Session is required",
          authentication: { scheme: "AgenticWorld", audience, transport: "resource", ...(challenge ? { challenge } : {}) } },
        { "WWW-Authenticate": offer });
        return;
      }
      if (agentId && authentication.session.agentId.toLowerCase() !== agentId.toLowerCase()) throw new InvalidHeaders();
      if (authentication.user === null || (!newToken && !await authorize({ session: authentication.session, user: authentication.user }, request)))
        throw new AgentAuthorizationError();
      request.agentic = { session: authentication.session, user: authentication.user };
      if (newToken) {
        response.setHeader("Agent-Session", newToken);
        response.setHeader("Agent-Session-Expires-At", String(authentication.session.expiresAt));
      }
    } catch (error) {
      if (error instanceof InvalidHeaders) { send(400, { error: "Malformed or conflicting Agent authentication headers" }); return; }
      if (error instanceof AgentAuthenticationError) { send(401, { error: "Agent proof rejected; request a new challenge before retrying" }); return; }
      if (error instanceof AgentAuthorizationError) { send(403, { error: "This service has not granted the agent this resource" }); return; }
      // Store/permission failures are not new authentication challenges. Never
      // disclose backend errors or continue to a protected handler on failure.
      send(503, { error: "Could not validate access to this resource" });
      return;
    }
    // Application errors belong to the application's error handler, not auth.
    await next();
  };
}

class InvalidHeaders extends Error {}
