import { PublicKey } from "@solana/web3.js";
import { getGiftcardPda, getProgram, getProvider, loadKeypair } from "../../anchorClient.js";
import { decryptUint128WithEncrypt } from "../../lib/encryptNetwork.js";
import { assertDecryptPermission } from "../../lib/permissions.js";
import { uint128ToLeBytes } from "../../lib/encoding.js";
import { solGiftConfig } from "../../config.js";

function decodeGiftcodeFromUint128(value: bigint): string {
  const bytes = uint128ToLeBytes(value);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
}

async function decryptGiftcodeWithEncryptSdk(
  encGiftcodeHex: string,
  mint: PublicKey,
): Promise<string> {
  const value = await decryptUint128WithEncrypt(encGiftcodeHex, loadKeypair());
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
  if (backend !== 0) {
    throw new Error(
      "Giftcard backend is not Encrypt/REFHE (expected backend=0)",
    );
  }

  const owner = provider.wallet.publicKey;
  await assertDecryptPermission(mint, owner, 0);
  console.log("[pure-REFHE] Decrypting for owner:", owner.toBase58());

  const encGiftcodeHex =
    "0x" + Buffer.from(giftcardAccount.keyHandle).toString("hex");

  console.log("[pure-REFHE] Encrypted giftcode handle (hex):", encGiftcodeHex);

  const giftcodePlain = await decryptGiftcodeWithEncryptSdk(
    encGiftcodeHex,
    mint,
  );

  console.log("[pure-REFHE] Decrypted giftcode (plaintext):", giftcodePlain);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
