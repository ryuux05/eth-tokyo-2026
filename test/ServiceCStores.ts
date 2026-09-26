import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { deploymentStores, redisRestCommand, redisStores } from "../demo-service-c/stores.js";

test("Service C hosted storage fails closed without Redis and isolates audiences", async () => {
  assert.throws(() => deploymentStores("https://service-c.example", {}), /requires shared Redis/);
  assert.throws(() => deploymentStores("http://127.0.0.1:8807", { VERCEL: "1" }), /requires shared Redis/);
  assert.throws(() => deploymentStores("http://127.0.0.1:8807", { UPSTASH_REDIS_REST_URL: "https://redis.example" }), /Both Redis/);
  assert.ok(deploymentStores("http://127.0.0.1:8807", {}));
  const values = new Map<string, string>();
  const commands: (string | number)[][] = [];
  const command = async (args: (string | number)[]) => {
    commands.push(args);
    const key = String(args[1]);
    if (args[0] === "SET") { values.set(key, String(args[2])); return "OK"; }
    const found = values.get(key) ?? null;
    if (args[0] === "GETDEL") values.delete(key);
    return found;
  };
  const first = redisStores(command, "https://service-c.example:11155111");
  const second = redisStores(command, "https://service-c.example:11155111");
  const other = redisStores(command, "https://preview.example:11155111");
  const nonce = `0x${"12".repeat(32)}` as Hex;
  const agentId = "0x1111111111111111111111111111111111111111" as Address;
  const now = Math.floor(Date.now() / 1000);
  const challenge = { agentId, audience: "https://service-c.example", chainId: 11155111, nonce, issuedAt: now, expiresAt: now + 60 };
  await first.challenges.put(challenge);
  assert.deepEqual(await second.challenges.get(nonce), challenge);
  assert.equal(await other.challenges.get(nonce), undefined);
  assert.deepEqual(await Promise.all([first.challenges.consume(nonce), second.challenges.consume(nonce)]), [true, false]);
  assert.equal(await second.challenges.get(nonce), undefined);
  await first.sessions.put(nonce, { agentId, expiresAt: now + 60 });
  assert.equal((await second.sessions.get(nonce))?.agentId, agentId);
  for (const set of commands.filter(args => args[0] === "SET")) {
    assert.equal(set[3], "EX"); assert.ok(Number(set[4]) > 0 && Number(set[4]) <= 60);
  }
  await assert.rejects(first.sessions.put(nonce, { agentId, expiresAt: now - 1 }), /expired/);
});

test("Service C Redis REST transport keeps credentials server-side and redacts failures", async () => {
  assert.throws(() => redisRestCommand("http://redis.example", "secret"), /HTTPS/);
  let observed: RequestInit | undefined;
  const transport: typeof fetch = async (_input, init) => {
    observed = init;
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  };
  assert.equal(await redisRestCommand("https://redis.example", "private-test-token", transport)(["SET", "key", "value"]), "OK");
  assert.equal(new Headers(observed!.headers).get("Authorization"), "Bearer private-test-token");
  assert.equal(observed!.redirect, "error");
  const bad: typeof fetch = async () => { throw new Error("private-test-token https://private.example"); };
  await assert.rejects(redisRestCommand("https://redis.example", "private-test-token", bad)(["GET", "key"]), error => {
    assert.equal((error as Error).message, "Shared authentication storage unavailable"); return true;
  });
});
