export const ENCRYPT_EUINT128_FHE_TYPE = Number(
  process.env.ENCRYPT_EUINT128_FHE_TYPE || "5",
);

export function uint128ToLeBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < out.length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function leBytesToUint128(bytes: Uint8Array): bigint {
  let value = 0n;
  const len = Math.min(bytes.length, 16);
  for (let i = 0; i < len; i++) {
    value |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return value;
}

export function hexToBuffer(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0) return Buffer.alloc(0);
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  return Buffer.from(clean, "hex");
}

export function bufferToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}
