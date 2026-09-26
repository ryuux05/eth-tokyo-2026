import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import type { AuthenticationChallenge, ChallengeStore, Session, SessionStore } from "../sdk/service.js";

export type PolicyEvent = { at: string; agentId: Address; target: Address; amount: string; decision: string;
  blockNumber: string; policyRevision: string; source: string };
export type OwnerChallenge = { owner: Address; nonce: Hex; message: string; expiresAt: number };
export type ServiceCStores = { challenges: ChallengeStore; sessions: SessionStore;
  owners: { has(owner: Address): Promise<boolean>; register(owner: Address): Promise<void> };
  ownerChallenges: { put(value: OwnerChallenge): Promise<void>; get(nonce: Hex): Promise<OwnerChallenge | undefined>; consume(nonce: Hex): Promise<boolean> };
  record(event: PolicyEvent): Promise<void>; events(): Promise<PolicyEvent[]> };

/** Only for the loopback demo/test adapter. Never used by a hosted deployment. */
export function memoryStores(): ServiceCStores {
  const challenges = new Map<Hex, AuthenticationChallenge>(), sessions = new Map<Hex, Session>();
  const owners = new Set<string>(), ownerChallenges = new Map<Hex, OwnerChallenge>();
  const events: PolicyEvent[] = [];
  const prune = <T extends { expiresAt: number }>(store: Map<Hex, T>) => {
    for (const [key, value] of store) if (value.expiresAt <= Math.floor(Date.now() / 1000)) store.delete(key);
  };
  return {
    owners: { async has(owner) { return owners.has(owner.toLowerCase()); }, async register(owner) {
      if (owners.size >= 1000 && !owners.has(owner.toLowerCase())) throw new Error("Owner capacity reached");
      owners.add(owner.toLowerCase());
    } },
    ownerChallenges: {
      async put(value) { prune(ownerChallenges); if (ownerChallenges.size >= 1000) throw new Error("Owner challenge capacity reached"); ownerChallenges.set(value.nonce, value); },
      async get(nonce) { prune(ownerChallenges); return ownerChallenges.get(nonce); },
      async consume(nonce) { prune(ownerChallenges); return ownerChallenges.delete(nonce); },
    },
    challenges: {
      async put(value) { prune(challenges); if (challenges.size >= 1000) throw new Error("Challenge capacity reached"); challenges.set(value.nonce, value); },
      async get(key) { prune(challenges); return challenges.get(key); },
      async consume(key) { prune(challenges); return challenges.delete(key); },
    },
    sessions: {
      async put(key, value) { prune(sessions); if (sessions.size >= 1000) throw new Error("Session capacity reached"); sessions.set(key, value); },
      async get(key) { prune(sessions); return sessions.get(key); },
    },
    async record(event) { events.unshift(event); events.length = Math.min(events.length, 40); },
    async events() { return [...events]; },
  };
}

export type RedisCommand = (command: (string | number)[]) => Promise<unknown>;
export function redisRestCommand(url: string, token: string, transport: typeof fetch = fetch): RedisCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !token)
    throw new Error("Redis requires an HTTPS REST endpoint and private token");
  return async command => {
    try {
      const response = await transport(parsed, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command), cache: "no-store", signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error("Redis request rejected");
      const value = await response.json() as { error?: string; result?: unknown };
      if (value.error || !("result" in value)) throw new Error("Redis response rejected");
      return value.result;
    } catch { throw new Error("Shared authentication storage unavailable"); } // Never disclose tokens/RPC URLs.
  };
}

/** Independent instances share these keys. GETDEL is the atomic replay barrier. */
export function redisStores(command: RedisCommand, namespace: string): ServiceCStores {
  const prefix = `agentic-service-c:v1:${createHash("sha256").update(namespace).digest("hex")}`;
  const key = (kind: string, id = "") => `${prefix}:${kind}:${id.toLowerCase()}`;
  const get = async <T>(name: string): Promise<T | undefined> => {
    const value = await command(["GET", name]);
    if (value === null) return undefined;
    if (typeof value !== "string") throw new Error("Invalid shared state");
    return JSON.parse(value) as T;
  };
  const put = async (name: string, value: { expiresAt: number }) => {
    const ttl = value.expiresAt - Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("Cannot store expired authentication state");
    if (await command(["SET", name, JSON.stringify(value), "EX", ttl]) !== "OK") throw new Error("Shared state write failed");
  };
  return {
    owners: {
      async has(owner) { return await command(["GET", key("owner", owner)]) === "registered"; },
      async register(owner) { if (await command(["SET", key("owner", owner), "registered"]) !== "OK") throw new Error("Owner registration failed"); },
    },
    ownerChallenges: {
      put: value => put(key("owner-challenge", value.nonce), value),
      get: nonce => get<OwnerChallenge>(key("owner-challenge", nonce)),
      async consume(nonce) { return typeof await command(["GETDEL", key("owner-challenge", nonce)]) === "string"; },
    },
    challenges: {
      put: value => put(key("challenge", value.nonce), value),
      get: nonce => get<AuthenticationChallenge>(key("challenge", nonce)),
      async consume(nonce) { return typeof await command(["GETDEL", key("challenge", nonce)]) === "string"; },
    },
    sessions: { put: (hash, value) => put(key("session", hash), value), get: hash => get<Session>(key("session", hash)) },
    async record(event) {
      await command(["EVAL", "redis.call('LPUSH',KEYS[1],ARGV[1]);redis.call('LTRIM',KEYS[1],0,39);redis.call('EXPIRE',KEYS[1],3600);return 1", 1, key("events"), JSON.stringify(event)]);
    },
    async events() {
      const values = await command(["LRANGE", key("events"), 0, 39]);
      if (!Array.isArray(values)) throw new Error("Invalid shared activity state");
      return values.map(value => JSON.parse(String(value)) as PolicyEvent);
    },
  };
}

export function deploymentStores(origin: string, environment: NodeJS.ProcessEnv): ServiceCStores {
  const url = new URL(origin);
  const restUrl = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const token = environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  if (restUrl && token) return redisStores(redisRestCommand(restUrl, token), `${origin}:11155111`);
  if (restUrl || token) throw new Error("Both Redis URL and token are required");
  if (!environment.VERCEL && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) return memoryStores();
  throw new Error("Hosted Service C requires shared Redis authentication storage");
}
