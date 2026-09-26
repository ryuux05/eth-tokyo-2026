import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("bundled Windows signers match their manifest and target architectures", async () => {
  const manifest = JSON.parse(await readFile(new URL("../signer/prebuilt/manifest.json", import.meta.url), "utf8")) as Record<string, string>;
  for (const [architecture, machine] of [["x64", 0x8664], ["arm64", 0xaa64]] as const) {
    const bytes = await readFile(new URL(`../signer/prebuilt/win32-${architecture}/agentic-signer.exe`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest[architecture]);
    assert.equal(bytes.toString("ascii", 0, 2), "MZ");
    const peOffset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString("binary", peOffset, peOffset + 4), "PE\0\0");
    assert.equal(bytes.readUInt16LE(peOffset + 4), machine);
  }
});
