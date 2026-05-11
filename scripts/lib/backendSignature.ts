import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Keypair } from "@solana/web3.js";

const INIT_AUTH_DOMAIN = Buffer.from("MOGATE_GIFTCARD_INIT_V1");
const CLEANUP_AUTH_DOMAIN = Buffer.from("MOGATE_GIFTCARD_CLEANUP_V1");
const BURN_AUTH_DOMAIN = Buffer.from("MOGATE_GIFTCARD_BURN_V1");
const BATCH_BURN_AUTH_DOMAIN = Buffer.from("MOGATE_GIFTCARD_BATCH_BURN_V1");

function withLength(data: Uint8Array | string): Buffer {
  const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  if (body.length > 0xffff) {
    throw new Error("Backend authorization message component is too long");
  }
  const len = Buffer.alloc(2);
  len.writeUInt16LE(body.length);
  return Buffer.concat([len, body]);
}

function signBackendMessage(
  backendKeypair: Keypair,
  message: Uint8Array,
): TransactionInstruction {
  const signature = nacl.sign.detached(message, backendKeypair.secretKey);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: backendKeypair.publicKey.toBytes(),
    message,
    signature,
  });
}

export function buildInitializeGiftcardMessage(args: {
  programId: PublicKey;
  config: PublicKey;
  mint: PublicKey;
  backend: number;
  cipherRef: string;
  keyHandle: Uint8Array;
}): Buffer {
  return Buffer.concat([
    INIT_AUTH_DOMAIN,
    args.programId.toBuffer(),
    args.config.toBuffer(),
    args.mint.toBuffer(),
    Buffer.from([args.backend]),
    withLength(args.cipherRef),
    withLength(args.keyHandle),
  ]);
}

export function backendInitializeInstruction(
  backendKeypair: Keypair,
  args: Parameters<typeof buildInitializeGiftcardMessage>[0],
): TransactionInstruction {
  return signBackendMessage(backendKeypair, buildInitializeGiftcardMessage(args));
}

export function buildBackendCleanupMessage(args: {
  programId: PublicKey;
  config: PublicKey;
  giftcard: PublicKey;
  mint: PublicKey;
}): Buffer {
  return Buffer.concat([
    CLEANUP_AUTH_DOMAIN,
    args.programId.toBuffer(),
    args.config.toBuffer(),
    args.giftcard.toBuffer(),
    args.mint.toBuffer(),
  ]);
}

export function backendCleanupInstruction(
  backendKeypair: Keypair,
  args: Parameters<typeof buildBackendCleanupMessage>[0],
): TransactionInstruction {
  return signBackendMessage(backendKeypair, buildBackendCleanupMessage(args));
}

export function buildBurnRedeemedMessage(args: {
  programId: PublicKey;
  config: PublicKey;
  giftcard: PublicKey;
  mint: PublicKey;
  tokenOwner: PublicKey;
}): Buffer {
  return Buffer.concat([
    BURN_AUTH_DOMAIN,
    args.programId.toBuffer(),
    args.config.toBuffer(),
    args.giftcard.toBuffer(),
    args.mint.toBuffer(),
    args.tokenOwner.toBuffer(),
  ]);
}

export function backendBurnInstruction(
  backendKeypair: Keypair,
  args: Parameters<typeof buildBurnRedeemedMessage>[0],
): TransactionInstruction {
  return signBackendMessage(backendKeypair, buildBurnRedeemedMessage(args));
}

export function buildBatchBurnMessage(args: {
  programId: PublicKey;
  config: PublicKey;
  accountGroups: Array<{
    giftcard: PublicKey;
    mint: PublicKey;
    ownerTokenAccount: PublicKey;
    tokenOwner: PublicKey;
  }>;
}): Buffer {
  const batchAccounts = Buffer.concat(
    args.accountGroups.flatMap((group) => [
      group.giftcard.toBuffer(),
      group.mint.toBuffer(),
      group.ownerTokenAccount.toBuffer(),
      group.tokenOwner.toBuffer(),
    ]),
  );

  return Buffer.concat([
    BATCH_BURN_AUTH_DOMAIN,
    args.programId.toBuffer(),
    args.config.toBuffer(),
    withLength(batchAccounts),
  ]);
}

export function backendBatchBurnInstruction(
  backendKeypair: Keypair,
  args: Parameters<typeof buildBatchBurnMessage>[0],
): TransactionInstruction {
  return signBackendMessage(backendKeypair, buildBatchBurnMessage(args));
}
