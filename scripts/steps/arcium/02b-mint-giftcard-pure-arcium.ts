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
import * as anchor from "@coral-xyz/anchor";
import { encryptUint128WithArcium, encodeGiftcodeToUint128 } from "../../lib/arciumGiftcard.js";
import { backendInitializeInstruction } from "../../lib/backendSignature.js";
import { createGiftcardNftWithProgramFreezeAuthority } from "../../lib/giftcardNft.js";

async function encryptGiftcodeWithArciumSdk(
  giftcode: string,
  mint: PublicKey,
  provider: anchor.AnchorProvider,
): Promise<string> {
  anchor.setProvider(provider);
  const config = solGiftConfig;
  const mxeProgramId = new PublicKey(
    config.arcium.mxeProgramId ||
      process.env.ARCIUM_MXE_PROGRAM_ID ||
      "11111111111111111111111111111111",
  );
  return encryptUint128WithArcium(
    encodeGiftcodeToUint128(giftcode),
    provider,
    mxeProgramId,
    mint,
  );
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
  console.log("[pure-Arcium] Minting NFT giftcard with Metaplex metadata...");
  const collectionMint = new PublicKey(collection.mint);
  const program = getProgram();
  const configPda = getConfigPda(program.programId);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);
  const tokenOwner = mintCfg.to
    ? new PublicKey(mintCfg.to)
    : provider.wallet.publicKey;
  if (!tokenOwner.equals(provider.wallet.publicKey)) {
    console.log(
      `[pure-Arcium] step3:unwrap must be signed by token owner ${tokenOwner.toBase58()}, not minter ${provider.wallet.publicKey.toBase58()}.`,
    );
  }

  const { mint } = await createGiftcardNftWithProgramFreezeAuthority({
    connection,
    payer: (wallet as any).payer,
    tokenOwner,
    freezeAuthority: freezeAuthorityPda,
    collectionMint,
    uri: mintCfg.uri,
    name: "Mogate Giftcard (pure Arcium)",
    symbol: collection.symbol || "MOGA",
  });
  console.log("[pure-Arcium] Minted NFT:", mint.toBase58());

  // 2) Plaintext giftcode
  const giftcode =
    mintCfg.plaintextGiftcode ||
    `MOGATE_SOL_PURE_ARCIUM_${Date.now().toString().slice(-6)}`;
  console.log("[pure-Arcium] Giftcode (plaintext, testing only):", giftcode);

  // 3) Encrypt giftcode with Arcium network (confidential computation)
  const encHandleHex = await encryptGiftcodeWithArciumSdk(giftcode, mint, provider);
  console.log("[pure-Arcium] Encrypted giftcode handle (hex):", encHandleHex);

  // 4) Store handle in Giftcard PDA (cipher_ref empty in pure mode)
  const giftcardPda = getGiftcardPda(program.programId, mint);

  const backend = 1; // 1 = Arcium

  const keyHandleBytes = Buffer.from(
    encHandleHex.startsWith("0x") ? encHandleHex.slice(2) : encHandleHex,
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

  console.log("[pure-Arcium] initialize_giftcard tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.mint = mint.toBase58();
    config.giftcard.decrypt.cipherRef = "";
    config.giftcard.decrypt.giftcode = giftcode;
    config.giftcard.decrypt.aesKeyHex = "";
    config.giftcard.decrypt.backend = "arcium";
    config.giftcard.decrypt.keyHandleHex = encHandleHex;
    config.giftcard.decrypt.holderKeyHandleHex = "";
    config.giftcard.decrypt.encryptPermissionTx = "";
    config.giftcard.decrypt.mintTx = txSig;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
