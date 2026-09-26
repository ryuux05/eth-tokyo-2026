import { open, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { PaymentJournal, PaymentRecord } from "../sdk/payments.js";

/** Cross-process lock covers approval + signing + broadcast. Crash recovery is
 * deliberately manual: deleting a stale lock must never rebroadcast a payment. */
export async function withPaymentJournal<T>(configPath: string, action: (journal: PaymentJournal) => Promise<T>): Promise<T> {
  const path = `${configPath}.payments.json`;
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("PAYMENT_BUSY: another payment may be active. If the MCP crashed, inspect the payment journal before removing its stale lock; do not retry with a new request ID."); }
  try {
    await lock.writeFile(String(process.pid));
    let records: Record<string, PaymentRecord> = Object.create(null);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid journal");
      records = Object.assign(Object.create(null), parsed);
      for (const record of Object.values(records)) {
        if (record.operation) {
          for (const field of ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"] as const)
            record.operation[field] = BigInt(record.operation[field]);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid payment journal; left unchanged"); }
    return await action({ async get(id) { return Object.hasOwn(records, id) ? records[id] : undefined; }, async put(record) {
      records[record.requestId] = record;
      const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(records, (_, value) => typeof value === "bigint" ? value.toString() : value, 2), { flag: "wx", mode: 0o600 });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    } });
  } finally { await lock.close(); await rm(lockPath); }
}
