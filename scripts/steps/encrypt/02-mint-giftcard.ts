import fs from "node:fs";
import * as path from "node:path";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import {
  getConfigPda,
  getFreezeAuthorityPda,
  getGiftcardPda,
  loadBackendKeypair,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";
import { encryptUint128WithEncrypt } from "../../lib/encryptNetwork.js";
import { backendInitializeInstruction } from "../../lib/backendSignature.js";
import { createGiftcardNftWithProgramFreezeAuthority } from "../../lib/giftcardNft.js";

// Simple AES-GCM helper (same idea as ETH script)
async function encryptGiftcodeWithAes(
  giftcode: string,
): Promise<{ aesKeyHex: string; cipherRef: string }> {
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(16));
  const aesKeyHex = Array.from(aesKeyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const encoder = new TextEncoder();
  const giftcodeData = encoder.encode(giftcode);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    aesKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedGiftcode = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    giftcodeData,
  );

  const encryptedPayload = new Uint8Array(
    iv.length + encryptedGiftcode.byteLength,
  );
  encryptedPayload.set(iv);
  encryptedPayload.set(new Uint8Array(encryptedGiftcode), iv.length);

  const cipherRef = `giftcode_${Date.now()}.bin`;
  const outPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    cipherRef,
  );
  await fs.promises.writeFile(outPath, encryptedPayload);

  return { aesKeyHex: `0x${aesKeyHex}`, cipherRef };
}

async function encryptAesKeyWithEncryptSdk(aesKeyHex: string): Promise<string> {
  return encryptUint128WithEncrypt(
    aesKeyHexToBigInt(aesKeyHex),
    getProgram().programId,
  );
}

function aesKeyHexToBigInt(aesKeyHex: string): bigint {
  const clean = aesKeyHex.startsWith("0x") ? aesKeyHex.slice(2) : aesKeyHex;
  return BigInt("0x" + clean);
}

async function main() {
  const { collection, giftcard } = solGiftConfig;
  const { mint: mintCfg } = giftcard;

  if (!collection.mint)
    throw new Error(
      "collection.mint is required; run step1:create-collection or set collection.mint in scripts/config/mogate_giftcard.config.json",
    );
  if (!mintCfg.uri)
    throw new Error(
      "giftcard.uri is required in scripts/config/mogate_giftcard.config.json",
    );

  const provider = getProvider();
  const connection = provider.connection;
  const wallet: any = provider.wallet;

  console.log("[step2] Minter wallet:", wallet.publicKey.toBase58());

  // 1) Generate / pick plaintext giftcode.
  const giftcode =
    mintCfg.plaintextGiftcode ||
    `MOGATE_SOL_GIFTCODE_${Date.now().toString().slice(-6)}`;
  console.log("Giftcode (plaintext, testing only):", giftcode);

  // 2) AES-encrypt giftcode off-chain.
  const { aesKeyHex, cipherRef } = await encryptGiftcodeWithAes(giftcode);
  console.log("Encrypted giftcode saved to:", cipherRef);

  // 3) Encrypt AES key with Encrypt/REFHE before minting.
  // This keeps a bad Encrypt config or gRPC outage from orphaning a fresh NFT.
  const aesKeyBigInt = aesKeyHexToBigInt(aesKeyHex);
  console.log("AES key (uint128 bigint):", aesKeyBigInt.toString());

  const keyHandleHex = await encryptAesKeyWithEncryptSdk(aesKeyHex);
  console.log("Encrypted AES key handle (hex):", keyHandleHex);

  // 4) Mint fixed-supply giftcard token and attach Metaplex metadata.
  console.log("Minting NFT giftcard with Metaplex metadata...");
  const collectionMint = new PublicKey(collection.mint);
  const program = getProgram();
  const configPda = getConfigPda(program.programId);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);
  const tokenOwner = mintCfg.to
    ? new PublicKey(mintCfg.to)
    : provider.wallet.publicKey;
  if (!tokenOwner.equals(provider.wallet.publicKey)) {
    console.log(
      `[step2] step3:unwrap must be signed by token owner ${tokenOwner.toBase58()}, not minter ${provider.wallet.publicKey.toBase58()}.`,
    );
  }

  const { mint } = await createGiftcardNftWithProgramFreezeAuthority({
    connection,
    payer: (wallet as any).payer,
    tokenOwner,
    freezeAuthority: freezeAuthorityPda,
    collectionMint,
    uri: mintCfg.uri,
    name: "Mogate Giftcard",
    symbol: collection.symbol || "MOGA",
  });
  console.log("Minted NFT:", mint.toBase58());
  console.log("[step2] NFT token owner:", tokenOwner.toBase58());

  const mintInfo = await getMint(connection, mint);
  console.log(
    "[step2] Mint.freezeAuthority:",
    mintInfo.freezeAuthority?.toBase58() || "none",
  );
  console.log(
    "[step2] Mint.mintAuthority:",
    mintInfo.mintAuthority?.toBase58() || "none",
  );

  // 5) Initialize Giftcard PDA on mogate_giftcard program.
  const giftcardPda = getGiftcardPda(program.programId, mint);

  console.log(
    "[step2] Program freezeAuthority PDA:",
    freezeAuthorityPda.toBase58(),
  );

  const backend: number = mintCfg.backend.toLowerCase() === "arcium" ? 1 : 0; // 0 = Encrypt, 1 = Arcium

  const keyHandleBytes = Buffer.from(
    keyHandleHex.startsWith("0x") ? keyHandleHex.slice(2) : keyHandleHex,
    "hex",
  );

  const accounts = {
    authority: provider.wallet.publicKey,
    config: configPda,
    mint,
    giftcard: giftcardPda,
    freezeAuthority: freezeAuthorityPda,
    systemProgram: SystemProgram.programId,
  };

  const txSig = mintCfg.unsafeDemo
    ? await program.methods
        .unsafeInitializeGiftcard(cipherRef, backend, keyHandleBytes)
        .accountsStrict(accounts)
        .rpc()
    : await program.methods
        .initializeGiftcard(cipherRef, backend, keyHandleBytes)
        .preInstructions([
          backendInitializeInstruction(loadBackendKeypair(), {
            programId: program.programId,
            config: configPda,
            mint,
            backend,
            cipherRef,
            keyHandle: keyHandleBytes,
          }),
        ])
        .accountsStrict({
          ...accounts,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();

  console.log("initialize_giftcard tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.mint = mint.toBase58();
    config.giftcard.decrypt.cipherRef = cipherRef;
    config.giftcard.decrypt.giftcode = giftcode;
    config.giftcard.decrypt.aesKeyHex = aesKeyHex;
    config.giftcard.decrypt.backend = "encrypt";
    config.giftcard.decrypt.keyHandleHex = keyHandleHex;
    config.giftcard.decrypt.holderKeyHandleHex = "";
    config.giftcard.decrypt.encryptPermissionTx = "";
    config.giftcard.decrypt.mintTx = txSig;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
