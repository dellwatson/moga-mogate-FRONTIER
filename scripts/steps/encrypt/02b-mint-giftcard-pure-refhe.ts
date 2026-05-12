import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from "@solana/web3.js";
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

// Encode a short giftcode string into a uint128 (16 bytes, little-endian),
// same idea as the ETH 2b-mint-giftcode.pure-fhe.ts helper.
function encodeGiftcodeToUint128(code: string): bigint {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(code);
  const padded = new Uint8Array(16);
  padded.set(bytes.slice(0, 16));

  let result = 0n;
  for (let i = 0; i < 16; i++) {
    result |= BigInt(padded[i]) << (BigInt(i) * 8n);
  }
  return result;
}

async function encryptGiftcodeWithEncryptSdk(value: bigint): Promise<string> {
  return encryptUint128WithEncrypt(value, getProgram().programId);
}

async function main() {
  const { collection, giftcard } = solGiftConfig;
  const { mint: mintCfg } = giftcard;

  if (!collection.mint) throw new Error("collection.mint is required; run step1:create-collection or set collection.mint in scripts/config/mogate_giftcard.config.json");
  if (!mintCfg.uri) throw new Error("giftcard.uri is required in scripts/config/mogate_giftcard.config.json");

  const provider = getProvider();
  const connection = provider.connection;
  const wallet: any = provider.wallet;

  // 1) Mint fixed-supply giftcard token and attach Metaplex metadata.
  console.log("[pure-REFHE] Minting NFT giftcard with Metaplex metadata...");
  const collectionMint = new PublicKey(collection.mint);
  const program = getProgram();
  const configPda = getConfigPda(program.programId);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);
  const tokenOwner = mintCfg.to
    ? new PublicKey(mintCfg.to)
    : provider.wallet.publicKey;
  if (!tokenOwner.equals(provider.wallet.publicKey)) {
    console.log(
      `[pure-REFHE] step3:unwrap must be signed by token owner ${tokenOwner.toBase58()}, not minter ${provider.wallet.publicKey.toBase58()}.`,
    );
  }

  const { mint } = await createGiftcardNftWithProgramFreezeAuthority({
    connection,
    payer: (wallet as any).payer,
    tokenOwner,
    freezeAuthority: freezeAuthorityPda,
    collectionMint,
    uri: mintCfg.uri,
    name: "Mogate Giftcard (pure REFHE)",
    symbol: collection.symbol || "MOGA",
  });
  console.log("[pure-REFHE] Minted NFT:", mint.toBase58());

  // 2) Get plaintext giftcode (testing/dev)
  const giftcode =
    mintCfg.plaintextGiftcode ||
    `MOGATE_SOL_PURE_REFHE_${Date.now().toString().slice(-6)}`;
  console.log("[pure-REFHE] Giftcode (plaintext, testing only):", giftcode);

  // 3) Encode giftcode as uint128 and FHE-encrypt with Encrypt/REFHE
  const codeUint128 = encodeGiftcodeToUint128(giftcode);
  console.log("[pure-REFHE] Encoded giftcode uint128:", codeUint128.toString());

  const encGiftcodeHex = await encryptGiftcodeWithEncryptSdk(codeUint128);
  console.log("[pure-REFHE] Encrypted giftcode handle (hex):", encGiftcodeHex);

  // 4) Store ciphertext/handle in Giftcard PDA (cipher_ref empty in pure-FHE mode)
  const giftcardPda = getGiftcardPda(program.programId, mint);

  const backend = 0; // 0 = Encrypt/REFHE
  const keyHandleBytes = Buffer.from(
    encGiftcodeHex.startsWith("0x") ? encGiftcodeHex.slice(2) : encGiftcodeHex,
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

  const txSig = await (mintCfg.unsafeDemo
    ? program.methods.unsafeInitializeGiftcard("", backend, keyHandleBytes).accountsStrict(accounts)
    : program.methods
        .initializeGiftcard("", backend, keyHandleBytes)
        .preInstructions([
          backendInitializeInstruction(loadBackendKeypair(), {
            programId: program.programId,
            config: configPda,
            mint,
            backend,
            cipherRef: "",
            keyHandle: keyHandleBytes,
          }),
        ])
        .accountsStrict({
          ...accounts,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
  ).rpc();

  console.log("[pure-REFHE] initialize_giftcard tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.mint = mint.toBase58();
    config.giftcard.decrypt.cipherRef = "";
    config.giftcard.decrypt.giftcode = giftcode;
    config.giftcard.decrypt.aesKeyHex = "";
    config.giftcard.decrypt.backend = "encrypt";
    config.giftcard.decrypt.keyHandleHex = encGiftcodeHex;
    config.giftcard.decrypt.holderKeyHandleHex = "";
    config.giftcard.decrypt.encryptPermissionTx = "";
    config.giftcard.decrypt.mintTx = txSig;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
