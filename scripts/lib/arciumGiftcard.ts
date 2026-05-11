import {
  RescueCipher,
  getMXEPublicKey,
  x25519,
} from "@arcium-hq/client";
import * as anchor from "@coral-xyz/anchor";
import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { bufferToHex, hexToBuffer, leBytesToUint128, uint128ToLeBytes } from "./encoding.js";

function deriveClientPrivateKey(seed: string, mint: PublicKey): Uint8Array {
  return createHash("sha256")
    .update("mogate-arcium-giftcard:v1")
    .update(seed)
    .update(mint.toBuffer())
    .digest()
    .subarray(0, 32);
}

export async function encryptUint128WithArcium(
  value: bigint,
  provider: anchor.AnchorProvider,
  mxeProgramId: PublicKey,
  mint: PublicKey,
): Promise<string> {
  const mxePublicKey = await getMXEPublicKey(provider, mxeProgramId);
  if (!mxePublicKey) {
    throw new Error("MXE public key not available; ensure Arcium nodes/program are deployed");
  }

  const seed = process.env.ARCIUM_CLIENT_SECRET || provider.wallet.publicKey.toBase58();
  const clientPrivateKey = deriveClientPrivateKey(seed, mint);
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const nonce = randomBytes(16);
  const ciphertext = cipher.encrypt([value], nonce)[0];

  return bufferToHex(
    Buffer.concat([
      Buffer.from([1]),
      Buffer.from(clientPublicKey),
      Buffer.from(nonce),
      Buffer.from(ciphertext),
    ]),
  );
}

export async function decryptUint128WithArcium(
  handleHex: string,
  provider: anchor.AnchorProvider,
  mxeProgramId: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  const handle = hexToBuffer(handleHex);
  if (handle.length < 81 || handle[0] !== 1) {
    throw new Error("invalid Arcium giftcard handle");
  }

  const mxePublicKey = await getMXEPublicKey(provider, mxeProgramId);
  if (!mxePublicKey) {
    throw new Error("MXE public key not available; ensure Arcium nodes/program are deployed");
  }

  const seed = process.env.ARCIUM_CLIENT_SECRET || provider.wallet.publicKey.toBase58();
  const clientPrivateKey = deriveClientPrivateKey(seed, mint);
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const nonce = handle.subarray(33, 49);
  const ciphertext = Array.from(handle.subarray(49));
  return cipher.decrypt([ciphertext], nonce)[0];
}

export function encodeGiftcodeToUint128(code: string): bigint {
  const bytes = new TextEncoder().encode(code);
  return leBytesToUint128(bytes.slice(0, 16));
}

export function decodeGiftcodeFromUint128(value: bigint): string {
  const bytes = uint128ToLeBytes(value);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
}
