import fs from "node:fs";
import * as path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getGiftcardPda, getProgram, getProvider } from "../../anchorClient.js";
import * as anchor from "@coral-xyz/anchor";
import { decryptUint128WithArcium } from "../../lib/arciumGiftcard.js";
import { assertDecryptPermission } from "../../lib/permissions.js";
import { bufferToHex } from "../../lib/encoding.js";
import { solGiftConfig } from "../../config.js";

async function decryptGiftcodeWithAes(
  aesKeyHex: string,
  cipherRef: string,
): Promise<string> {
  const clean = aesKeyHex.startsWith("0x") ? aesKeyHex.slice(2) : aesKeyHex;
  const aesKeyBytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < aesKeyBytes.length; i++) {
    aesKeyBytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }

  const filePath = path.isAbsolute(cipherRef)
    ? cipherRef
    : path.join(path.dirname(new URL(import.meta.url).pathname), cipherRef);
  const encryptedData = await fs.promises.readFile(filePath);

  const iv = encryptedData.subarray(0, 12);
  const ciphertext = encryptedData.subarray(12);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    aesKeyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext,
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
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

  const cipherRef: string = giftcardAccount.cipherRef as string;
  await assertDecryptPermission(mint, provider.wallet.publicKey, 1);

  anchor.setProvider(provider);
  const anchorProvider = provider;

  const mxeProgramId = new PublicKey(
    solGiftConfig.arcium.mxeProgramId ||
      process.env.ARCIUM_MXE_PROGRAM_ID ||
      "11111111111111111111111111111111", // placeholder
  );

  const aesKeyBigInt = await decryptUint128WithArcium(
    bufferToHex(giftcardAccount.keyHandle),
    anchorProvider,
    mxeProgramId,
    mint,
  );
  const aesKeyHex = "0x" + aesKeyBigInt.toString(16).padStart(32, "0");

  console.log("Decrypted AES key (hex):", aesKeyHex);

  const giftcode = await decryptGiftcodeWithAes(aesKeyHex, cipherRef);
  console.log("Decrypted giftcode:", giftcode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
