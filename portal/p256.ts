import { p256 } from "@noble/curves/nist.js";
import { concatHex, hexToBytes, type Hex } from "viem";

/** Validate public coordinates before sending an owner wallet transaction. */
export function validP256PublicKey(qx: string, qy: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(qx) || !/^0x[0-9a-fA-F]{64}$/.test(qy)) return false;
  try {
    p256.ProjectivePoint.fromHex(hexToBytes(concatHex(["0x04", qx as Hex, qy as Hex])));
    return true;
  } catch {
    return false;
  }
}
