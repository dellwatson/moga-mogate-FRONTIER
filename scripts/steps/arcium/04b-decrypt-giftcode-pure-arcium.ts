import { PublicKey } from "@solana/web3.js";
import { getGiftcardPda, getProgram, getProvider } from "../../anchorClient.js";
import * as anchor from "@coral-xyz/anchor";
import { decryptUint128WithArcium, decodeGiftcodeFromUint128 } from "../../lib/arciumGiftcard.js";
import { assertDecryptPermission } from "../../lib/permissions.js";
import { solGiftConfig } from "../../config.js";

async function decryptGiftcodeWithArciumSdk(
  encHandleHex: string,
  mint: PublicKey,
): Promise<string> {
  anchor.setProvider(anchor.AnchorProvider.env());
  const mxeProgramId = new PublicKey(
    solGiftConfig.arcium.mxeProgramId ||
      process.env.ARCIUM_MXE_PROGRAM_ID ||
      "11111111111111111111111111111111",
  );
  const value = await decryptUint128WithArcium(
    encHandleHex,
    anchor.getProvider() as anchor.AnchorProvider,
    mxeProgramId,
    mint,
  );
  return decodeGiftcodeFromUint128(value);
}

async function main() {
  const mintStr = process.env.MINT || solGiftConfig.giftcard.decrypt.mint;
  if (!mintStr) throw new Error("MINT env var (mint address) is required");

  const program = getProgram();
  const provider = getProvider();
  const mint = new PublicKey(mintStr);

  const giftcardPda = getGiftcardPda(program.programId, mint);

  const giftcardAccount = await program.account.giftcard.fetch(giftcardPda);

  const backend: number = giftcardAccount.backend;
  if (backend !== 1) {
    throw new Error("Giftcard backend is not Arcium (expected backend=1)");
  }

  const owner = provider.wallet.publicKey;
  await assertDecryptPermission(mint, owner, 1);
  console.log("[pure-Arcium] Decrypting for owner:", owner.toBase58());

  const encHandleHex =
    "0x" + Buffer.from(giftcardAccount.keyHandle).toString("hex");

  console.log("[pure-Arcium] Encrypted giftcode handle (hex):", encHandleHex);

  const giftcodePlain = await decryptGiftcodeWithArciumSdk(encHandleHex, mint);

  console.log("[pure-Arcium] Decrypted giftcode (plaintext):", giftcodePlain);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
