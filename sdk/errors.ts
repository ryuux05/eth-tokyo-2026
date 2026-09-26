/** Expected credential failures, distinct from RPC/store outages. */
export class AgentAuthenticationError extends Error {}
/** A verified identity was not admitted by service-owned policy. */
export class AgentAuthorizationError extends Error {}
