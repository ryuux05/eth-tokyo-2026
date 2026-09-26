import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type PublicClient, type Hex } from "viem";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT, LEGACY_SEPOLIA_DEPLOYMENT, resolveSepoliaAgentDeployment, CLONE_PREFIX, CLONE_SUFFIX, trustedFactory, trustedImplementation } from "../sdk/core.js";
import { AgenticWorld, createServiceSdk } from "../sdk/service.js";
import { createAgenticWorldMcp, parseConfig } from "../mcp/server.js";

const otherImplementation = "0x1111111111111111111111111111111111111111" as Address;
const otherFactory = "0x2222222222222222222222222222222222222222" as Address;

test("deployment migration retains old identities without widening a service's chosen trust pin", async () => {
  const runtime = (implementation: Address) => `${CLONE_PREFIX}${implementation.slice(2).toLowerCase()}${CLONE_SUFFIX}` as Hex;
  assert.equal(resolveSepoliaAgentDeployment(runtime(SEPOLIA_DEPLOYMENT.implementation)), SEPOLIA_DEPLOYMENT);
  assert.equal(resolveSepoliaAgentDeployment(runtime(LEGACY_SEPOLIA_DEPLOYMENT.implementation)), LEGACY_SEPOLIA_DEPLOYMENT);
  assert.equal(resolveSepoliaAgentDeployment(runtime(otherImplementation)), undefined);
  assert.equal(resolveSepoliaAgentDeployment(`${runtime(SEPOLIA_DEPLOYMENT.implementation)}00`), undefined);
  assert.equal(resolveSepoliaAgentDeployment(`0xef0100${SEPOLIA_DEPLOYMENT.implementation.slice(2)}`), undefined);
  const agentId = otherImplementation;
  const aliases = { [agentId]: "Existing identity" };
  const config = parseConfig({ rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", chainId: SEPOLIA_CHAIN_ID,
    factory: LEGACY_SEPOLIA_DEPLOYMENT.factory, implementation: LEGACY_SEPOLIA_DEPLOYMENT.implementation,
    agentId, agentIds: [agentId], aliases });
  assert.equal(config.factory, SEPOLIA_DEPLOYMENT.factory);
  assert.equal(config.implementation, SEPOLIA_DEPLOYMENT.implementation);
  assert.deepEqual(config.agentIds, [agentId]); assert.deepEqual(config.aliases, aliases);
  let code = runtime(LEGACY_SEPOLIA_DEPLOYMENT.implementation);
  const common = { chainId: SEPOLIA_CHAIN_ID, audience: "https://service.example",
    client: { getChainId: async () => SEPOLIA_CHAIN_ID, getBlockNumber: async () => 123n, getCode: async () => code } as unknown as PublicClient,
    challenges: { put: async () => {}, get: async () => undefined, consume: async () => true },
    sessions: { put: async () => {}, get: async () => undefined } };
  const current = createServiceSdk(common);
  const legacy = createServiceSdk({ ...common, implementation: LEGACY_SEPOLIA_DEPLOYMENT.implementation });
  await legacy.createChallenge(agentId);
  await assert.rejects(current.createChallenge(agentId), /Unexpected agent/);
  code = runtime(SEPOLIA_DEPLOYMENT.implementation);
  await current.createChallenge(agentId);
  await assert.rejects(legacy.createChallenge(agentId), /Unexpected agent/);
});

test("Sepolia deployment is pinned across core, low-level service SDK, and AgenticWorld", () => {
  for (const address of Object.values(SEPOLIA_DEPLOYMENT)) assert.equal(getAddress(address).toLowerCase(), address.toLowerCase());
  assert.equal(trustedFactory(SEPOLIA_CHAIN_ID), SEPOLIA_DEPLOYMENT.factory);
  assert.equal(trustedImplementation(SEPOLIA_CHAIN_ID), SEPOLIA_DEPLOYMENT.implementation);
  assert.equal(trustedFactory(SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT.factory.toLowerCase() as Address), SEPOLIA_DEPLOYMENT.factory);
  assert.equal(trustedImplementation(SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT.implementation.toLowerCase() as Address), SEPOLIA_DEPLOYMENT.implementation);
  assert.throws(() => trustedFactory(SEPOLIA_CHAIN_ID, otherFactory), /Sepolia factory differs/);
  assert.throws(() => trustedImplementation(SEPOLIA_CHAIN_ID, otherImplementation), /Sepolia implementation differs/);

  const common = {
    client: {} as PublicClient,
    chainId: SEPOLIA_CHAIN_ID,
    audience: "https://service.example",
    challenges: { put: async () => {}, get: async () => undefined, consume: async () => true },
    sessions: { put: async () => {}, get: async () => undefined },
  };
  assert.doesNotThrow(() => createServiceSdk(common));
  assert.throws(() => createServiceSdk({ ...common, implementation: otherImplementation }), /Sepolia implementation differs/);
  assert.doesNotThrow(() => new AgenticWorld({ ...common, association: { mode: "manual", resolveUser: async () => null } }));
  assert.throws(() => new AgenticWorld({ ...common, pinnedImplementation: otherImplementation,
    association: { mode: "manual", resolveUser: async () => null } }), /Sepolia implementation differs/);
});

test("local and other chains still require an explicit trusted implementation", () => {
  assert.throws(() => trustedImplementation(31337), /trusted implementation is required/);
  assert.equal(trustedImplementation(31337, otherImplementation), otherImplementation);
  assert.equal(trustedFactory(31337, otherFactory), otherFactory);
});

test("MCP resolves Sepolia addresses from code and rejects config overrides", async () => {
  const input = { rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", chainId: SEPOLIA_CHAIN_ID };
  const config = parseConfig(input);
  assert.equal(config.factory, SEPOLIA_DEPLOYMENT.factory);
  assert.equal(config.implementation, SEPOLIA_DEPLOYMENT.implementation);
  assert.throws(() => parseConfig({ ...input, factory: otherFactory }), /Sepolia factory differs/);
  assert.throws(() => parseConfig({ ...input, implementation: otherImplementation }), /Sepolia implementation differs/);
  assert.throws(() => parseConfig({ ...input, rpcUrl: "http://remote.example" }), /RPC must use HTTPS/);
  await assert.rejects(createAgenticWorldMcp(input, `0x${"1".repeat(64)}`), /hardware-backed P-256/);
});

test("MCP config keeps multiple identities and local aliases without dropping revoked entries", () => {
  const first = "0x1111111111111111111111111111111111111111";
  const second = "0x2222222222222222222222222222222222222222";
  const config = parseConfig({ rpcUrl: "http://127.0.0.1:8545", chainId: 31337, implementation: otherImplementation,
    agentId: second, agentIds: [first, second], aliases: { [first.toUpperCase().replace("0X", "0x")]: "Research", [second]: "Payments" } });
  assert.deepEqual(config.agentIds, [getAddress(first), getAddress(second)]);
  assert.equal(config.aliases?.[first.toLowerCase()], "Research");
  assert.equal(config.aliases?.[second.toLowerCase()], "Payments");
  assert.throws(() => parseConfig({ ...config, aliases: { [first]: " " } }), /Invalid agent alias/);
  assert.throws(() => parseConfig({ ...config, aliases: { [first]: "bad\nname" } }), /Invalid agent alias/);
});
