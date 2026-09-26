import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type PublicClient } from "viem";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT, trustedFactory, trustedImplementation } from "../sdk/core.js";
import { AgenticWorld, createServiceSdk } from "../sdk/service.js";
import { createAgenticWorldMcp, parseConfig } from "../mcp/server.js";

const otherImplementation = "0x1111111111111111111111111111111111111111" as Address;
const otherFactory = "0x2222222222222222222222222222222222222222" as Address;

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
