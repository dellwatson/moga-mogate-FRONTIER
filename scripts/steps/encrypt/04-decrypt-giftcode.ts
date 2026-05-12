import fs from "node:fs";
import * as path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getGiftcardPda, getProgram, getProvider, loadKeypair } from "../../anchorClient.js";
import { decryptUint128WithEncrypt } from "../../lib/encryptNetwork.js";
import { assertDecryptPermission } from "../../lib/permissions.js";
import { bufferToHex } from "../../lib/encoding.js";
import { copyEncryptCiphertextForCurrentHolder } from "../../lib/encryptPermission.js";
import { solGiftConfig } from "../../config.js";

async function decryptAesKeyWithEncryptSdk(
  keyHandleHex: string,
): Promise<string> {
  const value = await decryptUint128WithEncrypt(keyHandleHex, loadKeypair());
  return "0x" + value.toString(16).padStart(32, "0");
}

async function decryptGiftcodeWithAes(
  aesKeyHex: string,
  cipherRef: string,
): Promise<string> {
  const clean = aesKeyHex.startsWith("0x") ? aesKeyHex.slice(2) : aesKeyHex;
  if (clean.length !== 32) {
    console.warn(
      "Expected 16-byte AES key (32 hex chars), got length",
      clean.length,
    );
  }

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
  if (backend !== 0) {
    throw new Error(
      "Giftcard backend is not Encrypt/REFHE (expected backend=0)",
    );
  }

  const owner = provider.wallet.publicKey;
  await assertDecryptPermission(mint, owner, 0);

  const cipherRef: string = giftcardAccount.cipherRef as string;
  const programKeyHandleHex = bufferToHex(giftcardAccount.keyHandle);
  const keyHandleHex =
    solGiftConfig.giftcard.decrypt.holderKeyHandleHex || programKeyHandleHex;

  console.log("cipherRef:", cipherRef);
  console.log("keyHandleHex:", keyHandleHex);

  let aesKeyHex: string;
  try {
    aesKeyHex = await decryptAesKeyWithEncryptSdk(keyHandleHex);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("PERMISSION_DENIED") &&
      !solGiftConfig.giftcard.decrypt.holderKeyHandleHex
    ) {
      console.log(
        "Encrypt denied the program-authorized ciphertext; creating holder-authorized copy...",
      );
      const permission = await copyEncryptCiphertextForCurrentHolder();
      console.log("encrypt copy_ciphertext tx:", permission.txSig);
      console.log("holder key handle:", permission.holderKeyHandleHex);
      aesKeyHex = await decryptAesKeyWithEncryptSdk(
        permission.holderKeyHandleHex,
      );
    } else {
      throw err;
    }
  }
  console.log("Decrypted AES key (hex):", aesKeyHex);

  const giftcode = await decryptGiftcodeWithAes(aesKeyHex, cipherRef);
  console.log("Decrypted giftcode:", giftcode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
