import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import type { AuthenticationChallenge, ChallengeStore, Session, SessionStore } from "../sdk/service.js";
import { redisRestCommand, type RedisCommand } from "../demo-service-c/stores.js";

export type Entitlement = { owner: Address; report: boolean };
export type WalletChallenge = { owner: Address; nonce: Hex; message: string; expiresAt: number };
export type OwnerSession = { owner: Address; expiresAt: number };
export type AgentPermissions = { agentId: Address; read: boolean; write: boolean };
export type Report = { text: string; updatedAt: string; updatedBy?: Address };
export type ServiceBEvent = { at: string; kind: string; agentId?: Address; owner?: Address; detail: string };
export type ServiceBStores = {
  owners: { get(owner: Address): Promise<Entitlement | undefined>; put(value: Entitlement): Promise<void> };
  wallets: { put(value: WalletChallenge): Promise<void>; get(nonce: Hex): Promise<WalletChallenge | undefined>; consume(nonce: Hex): Promise<boolean> };
  challenges: ChallengeStore; sessions: SessionStore;
  ownerSessions: { put(hash: Hex, value: OwnerSession): Promise<void>; get(hash: Hex): Promise<OwnerSession | undefined> };
  agents: { discover(owner: Address, value: AgentPermissions): Promise<void>; get(owner: Address, agentId: Address): Promise<AgentPermissions | undefined>;
    list(owner: Address): Promise<AgentPermissions[]>; put(owner: Address, value: AgentPermissions): Promise<void> };
  reports: { initialize(owner: Address, value: Report): Promise<void>; get(owner: Address): Promise<Report | undefined>; put(owner: Address, value: Report): Promise<void> };
  record(event: ServiceBEvent): Promise<void>; events(): Promise<ServiceBEvent[]>;
};

export function memoryServiceBStores(): ServiceBStores {
  const owners = new Map<string, Entitlement>(), events: ServiceBEvent[] = [];
  const agents = new Map<string, Map<string, AgentPermissions>>(), reports = new Map<string, Report>();
  const agentMap = (owner: Address) => {
    const id = owner.toLowerCase();
    if (!agents.has(id)) agents.set(id, new Map());
    return agents.get(id)!;
  };
  function expiring<T extends { expiresAt: number }>() {
    const values = new Map<Hex, T>();
    const prune = () => { for (const [key, value] of values) if (value.expiresAt <= Math.floor(Date.now() / 1000)) values.delete(key); };
    return {
      async put(key: Hex, value: T) { prune(); if (values.size >= 1000) throw new Error("Store capacity reached"); values.set(key, value); },
      async get(key: Hex) { prune(); return values.get(key); },
      async consume(key: Hex) { prune(); return values.delete(key); },
    };
  }
  const challenges = expiring<AuthenticationChallenge>(), wallets = expiring<WalletChallenge>(), sessions = expiring<Session>();
  return {
    owners: { async get(owner) { return owners.get(owner.toLowerCase()); }, async put(value) {
      if (owners.size >= 1000 && !owners.has(value.owner.toLowerCase())) throw new Error("Owner capacity reached");
      owners.set(value.owner.toLowerCase(), value);
    } },
    challenges: { ...challenges, put: value => challenges.put(value.nonce, value) },
    wallets: { ...wallets, put: value => wallets.put(value.nonce, value) }, sessions,
    ownerSessions: expiring<OwnerSession>(),
    agents: {
      async discover(owner, value) { const map = agentMap(owner); if (!map.has(value.agentId.toLowerCase())) { if (map.size >= 1000) throw new Error("Agent capacity reached"); map.set(value.agentId.toLowerCase(), value); } },
      async get(owner, agentId) { return agentMap(owner).get(agentId.toLowerCase()); },
      async list(owner) { return [...agentMap(owner).values()]; },
      async put(owner, value) { agentMap(owner).set(value.agentId.toLowerCase(), value); },
    },
    reports: {
      async initialize(owner, value) { if (!reports.has(owner.toLowerCase())) reports.set(owner.toLowerCase(), value); },
      async get(owner) { return reports.get(owner.toLowerCase()); },
      async put(owner, value) { reports.set(owner.toLowerCase(), value); },
    },
    async record(event) { events.unshift(event); events.length = Math.min(events.length, 60); },
    async events() { return [...events]; },
  };
}

export function redisServiceBStores(command: RedisCommand, namespace: string): ServiceBStores {
  const prefix = `agentic-service-b:v1:${createHash("sha256").update(namespace).digest("hex")}`;
  const key = (kind: string, id = "") => `${prefix}:${kind}:${id.toLowerCase()}`;
  async function get<T>(name: string): Promise<T | undefined> {
    const result = await command(["GET", name]);
    if (result === null) return undefined;
    if (typeof result !== "string") throw new Error("Invalid shared state");
    return JSON.parse(result) as T;
  }
  async function put(name: string, value: { expiresAt: number }) {
    const ttl = value.expiresAt - Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("Cannot store expired proof");
    if (await command(["SET", name, JSON.stringify(value), "EX", ttl]) !== "OK") throw new Error("Shared state write failed");
  }
  const consume = async (name: string) => typeof await command(["GETDEL", name]) === "string";
  return {
    owners: { get: owner => get<Entitlement>(key("owner", owner)), async put(value) {
      if (await command(["SET", key("owner", value.owner), JSON.stringify(value)]) !== "OK") throw new Error("Registration failed");
    } },
    wallets: { put: value => put(key("wallet", value.nonce), value), get: nonce => get<WalletChallenge>(key("wallet", nonce)), consume: nonce => consume(key("wallet", nonce)) },
    challenges: { put: value => put(key("challenge", value.nonce), value), get: nonce => get<AuthenticationChallenge>(key("challenge", nonce)), consume: nonce => consume(key("challenge", nonce)) },
    sessions: { put: (hash, value) => put(key("session", hash), value), get: hash => get<Session>(key("session", hash)) },
    ownerSessions: { put: (hash, value) => put(key("owner-session", hash), value), get: hash => get<OwnerSession>(key("owner-session", hash)) },
    agents: {
      async discover(owner, value) { await command(["HSETNX", key("agents", owner), value.agentId.toLowerCase(), JSON.stringify(value)]); },
      async get(owner, agentId) {
        const value = await command(["HGET", key("agents", owner), agentId.toLowerCase()]);
        if (value === null) return undefined;
        if (typeof value !== "string") throw new Error("Invalid permissions");
        return JSON.parse(value) as AgentPermissions;
      },
      async list(owner) {
        const values = await command(["HVALS", key("agents", owner)]);
        if (!Array.isArray(values)) throw new Error("Invalid agent list");
        return values.map(value => JSON.parse(String(value)) as AgentPermissions);
      },
      async put(owner, value) { await command(["HSET", key("agents", owner), value.agentId.toLowerCase(), JSON.stringify(value)]); },
    },
    reports: {
      async initialize(owner, value) { await command(["SET", key("report", owner), JSON.stringify(value), "NX"]); },
      get: owner => get<Report>(key("report", owner)),
      async put(owner, value) { if (await command(["SET", key("report", owner), JSON.stringify(value)]) !== "OK") throw new Error("Could not save report"); },
    },
    async record(event) {
      await command(["EVAL", "redis.call('LPUSH',KEYS[1],ARGV[1]);redis.call('LTRIM',KEYS[1],0,59);redis.call('EXPIRE',KEYS[1],3600);return 1", 1, key("events"), JSON.stringify(event)]);
    },
    async events() {
      const values = await command(["LRANGE", key("events"), 0, 59]);
      if (!Array.isArray(values)) throw new Error("Invalid activity state");
      return values.map(value => JSON.parse(String(value)) as ServiceBEvent);
    },
  };
}

export function hostedServiceBStores(origin: string, environment: NodeJS.ProcessEnv): ServiceBStores {
  const url = environment.UPSTASH_REDIS_REST_URL?.trim() || environment.KV_REST_API_URL?.trim();
  const token = environment.UPSTASH_REDIS_REST_TOKEN?.trim() || environment.KV_REST_API_TOKEN?.trim();
  if (!url || !token) throw new Error("Configure both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  return redisServiceBStores(redisRestCommand(url, token), `${origin}:11155111`);
}
