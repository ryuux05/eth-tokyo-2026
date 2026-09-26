import type { IncomingMessage, ServerResponse } from "node:http";
import { assertAudience } from "./core.js";
import type { Session } from "./service.js";

export type AgenticAuthentication<User> = { session: Session; user: User };
export type AgenticRequest<User> = IncomingMessage & { agentic?: AgenticAuthentication<User> };
export type AgenticMiddlewareOptions<User> = {
  realm?: string;
  challengeEndpoint?: string;
  sessionEndpoint?: string;
  /** Service-owned permission check, evaluated for every resource request. */
  authorize: (authentication: AgenticAuthentication<User>, request: IncomingMessage) => boolean | Promise<boolean>;
};
export type AgenticMiddleware<User> = (
  request: AgenticRequest<User>, response: ServerResponse, next: () => void | Promise<void>,
) => Promise<void>;

/** Node HTTP / Express-compatible resource middleware. Mount only on routes
 * offering Agentic World, after any public/human-auth fallback. It never wraps
 * arbitrary 401 responses or installs the challenge/session endpoints itself. */
export function createAgenticWorldMiddleware<User>(
  service: { readSession: (token: string) => Promise<{ session: Session; user: User | null } | undefined> },
  audience: string,
  options: AgenticMiddlewareOptions<User>,
): AgenticMiddleware<User> {
  assertAudience(audience);
  if (typeof options.authorize !== "function") throw new Error("Provide a service-owned resource authorization callback");
  const realm = options.realm ?? "Agentic World";
  if (/[\x00-\x1f\x7f]/.test(realm)) throw new Error("Invalid authentication realm");
  const endpoint = (value: string) => {
    if (!value.startsWith("/") || value.startsWith("//") || /[\\"#\s\x00-\x1f\x7f]/.test(value))
      throw new Error("Authentication endpoints must be same-origin absolute paths");
    return value;
  };
  const challengeEndpoint = endpoint(options.challengeEndpoint ?? "/agent/challenge");
  const sessionEndpoint = endpoint(options.sessionEndpoint ?? "/agent/session");
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const offer = `AgenticWorld realm=${quote(realm)}, challenge=${quote(challengeEndpoint)}, session=${quote(sessionEndpoint)}, audience=${quote(audience)}`;
  const authorize = options.authorize;
  return async (request, response, next) => {
    delete request.agentic;
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
      response.end(JSON.stringify(value));
    };
    try {
      const token = request.headers["agent-session"];
      const authentication = typeof token === "string" ? await service.readSession(token) : undefined;
      if (!authentication) {
        send(401, { error: "A valid Agent-Session is required",
          authentication: { scheme: "AgenticWorld", audience, challengeEndpoint, sessionEndpoint } },
        { "WWW-Authenticate": offer });
        return;
      }
      if (authentication.user === null || !await authorize({ session: authentication.session, user: authentication.user }, request)) {
        send(403, { error: "This service has not granted the agent this resource" });
        return;
      }
      request.agentic = { session: authentication.session, user: authentication.user };
    } catch {
      // Store/permission failures are not new authentication challenges. Never
      // disclose backend errors or continue to a protected handler on failure.
      send(503, { error: "Could not validate access to this resource" });
      return;
    }
    // Application errors belong to the application's error handler, not auth.
    await next();
  };
}
