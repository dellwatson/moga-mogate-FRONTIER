import fs from "node:fs";
import * as path from "node:path";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getConfigPda,
  getGiftcardPda,
  getFreezeAuthorityPda,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";
import { encryptUint128WithEncrypt } from "../../lib/encryptNetwork.js";

async function main() {
  const program = getProgram();
  const provider = getProvider();
  const payer = provider.wallet;

  const { collection, giftcard } = solGiftConfig;
  const { mint: mintCfg } = giftcard;

  console.log("Config loaded:", {
    giftcardTo: mintCfg.to,
    collectionMint: collection.mint,
    giftcardUri: mintCfg.uri,
  });

  if (!collection.mint)
    throw new Error(
      "collection.mint is required; run step1:create-collection or set collection.mint in scripts/config/mogate_giftcard.config.json",
    );
  if (!mintCfg.uri)
    throw new Error(
      "giftcard.uri is required in scripts/config/mogate_giftcard.config.json",
    );

  // Generate a new mint keypair for this giftcard
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Generate a dedicated token account keypair for this giftcard
  // The on-chain program expects `token_account` to be an `init`-created
  // token account, which must be backed by a real keypair (not a PDA).
  const tokenAccountKeypair = Keypair.generate();
  const tokenAccount = tokenAccountKeypair.publicKey;

  // Giftcard metadata
  const recipient = mintCfg.to ? new PublicKey(mintCfg.to) : payer.publicKey;
  const metadataUri = mintCfg.uri;
  const name = "MOGATE Giftcard";
  const symbol = collection.symbol || "MOGA";
  const collectionMint = new PublicKey(collection.mint);

  // Generate giftcode and encrypt it
  const giftcode = mintCfg.plaintextGiftcode || `GIFT-${Date.now()}`;
  console.log("Plaintext giftcode:", giftcode);

  // Simple AES-GCM encryption (same as existing mint script)
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
  const cipherPath = `./scripts/data/${cipherRef}`;

  // Ensure data directory exists
  const dataDir = path.dirname(cipherPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(cipherPath, Buffer.from(encryptedPayload));
  console.log("Encrypted giftcode to:", cipherRef);
  console.log("AES key (hex):", aesKeyHex);

  // Encrypt the AES key with Encrypt backend, authorizing to the
  // Mogate program so that holder access is granted on unwrap via
  // the on-chain Encrypt copy path.
  const keyHandle = await encryptUint128WithEncrypt(
    BigInt("0x" + aesKeyHex),
    program.programId,
  );
  console.log("Encrypted AES key, key handle:", keyHandle);

  // Convert hex handle (possibly 0x-prefixed) to raw bytes for the program
  const keyHandleBytes = Buffer.from(
    keyHandle.startsWith("0x") ? keyHandle.slice(2) : keyHandle,
    "hex",
  );

  // Get required PDAs
  const configPda = getConfigPda(program.programId);
  const giftcardPda = getGiftcardPda(program.programId, mint);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);

  console.log("Minting giftcard with checkout flow...");
  console.log("Mint:", mint.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Backend:", mintCfg.backend);

  // Payment and signature configuration
  const rawAmount = solGiftConfig.checkout?.payment?.amount || 0;
  const paymentToken = solGiftConfig.checkout?.payment?.token
    ? new PublicKey(solGiftConfig.checkout.payment.token)
    : undefined;
  const signature = solGiftConfig.checkout?.signature || "";

  // Smart amount conversion based on token type
  let paymentAmount: number;
  let amountDisplay: string;

  if (!paymentToken) {
    // Native SOL: convert SOL to lamports
    paymentAmount = Math.floor(rawAmount * 1_000_000_000);
    amountDisplay = `${rawAmount} SOL`;
  } else {
    // SPL token: use raw amount as-is (integer/lamports)
    paymentAmount = Math.floor(rawAmount);
    amountDisplay = `${rawAmount} tokens`;
  }

  console.log("Checkout configuration:", {
    payment: {
      amount: paymentAmount,
      display: amountDisplay,
      token: paymentToken,
      isNative: !paymentToken,
    },
    signature: signature ? "provided" : "none (unsafe mode)",
  });

  // Choose checkout method based on signature presence
  const useSafeCheckout = signature.length > 0;
  const checkoutMethod = useSafeCheckout ? "checkout" : "unsafeCheckout";

  console.log(`Using ${useSafeCheckout ? "safe" : "unsafe"} checkout method`);

  // Create the transaction
  const tx = await program.methods[checkoutMethod](
    // Method chosen based on signature presence
    recipient,
    metadataUri,
    name,
    symbol,
    collectionMint,
    cipherRef,
    mintCfg.backend === "encrypt" ? 0 : 1, // Backend: 0=Encrypt, 1=Arcium
    keyHandleBytes,
  )
    .accountsStrict({
      payer: payer.publicKey,
      tokenOwner: recipient,
      mint,
      tokenAccount,
      giftcard: giftcardPda,
      config: configPda,
      freezeAuthority: freezeAuthorityPda,
      metadataProgram: SystemProgram.programId, // Placeholder for now
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([mintKeypair, tokenAccountKeypair])
    .transaction();

  const instructions = [];

  // Add signature verification instruction if using safe checkout
  if (useSafeCheckout && signature) {
    // Add Ed25519 signature verification instruction
    // This would verify the backend signature before the checkout instruction
    console.log("Adding signature verification instruction...");
    // TODO: Implement signature verification instruction
    // For now, we'll skip this part
  }

  instructions.push(tx);

  const transaction = new Transaction().add(...instructions);

  // Send and confirm transaction
  const txSig = await sendAndConfirmTransaction(
    provider.connection,
    transaction,
    [payer.payer, mintKeypair, tokenAccountKeypair],
    { commitment: "confirmed" },
  );

  console.log("Checkout mint transaction:", txSig);

  // Update config with mint details
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.mint = mint.toBase58();
    config.giftcard.decrypt.cipherRef = cipherRef;
    config.giftcard.decrypt.giftcode = giftcode;
    config.giftcard.decrypt.aesKeyHex = aesKeyHex;
    config.giftcard.decrypt.backend = mintCfg.backend;
    config.giftcard.decrypt.keyHandleHex = keyHandle;
    // Reset holder-specific Encrypt handle and permission so the
    // next decrypt run will start from the program-authorized
    // handle for this mint and only create a new holder handle
    // after unwrap.
    config.giftcard.decrypt.holderKeyHandleHex = "";
    config.giftcard.decrypt.encryptPermissionTx = "";
    config.giftcard.decrypt.mintTx = txSig;
  });

  console.log("✅ Giftcard successfully minted with checkout flow!");
  console.log("🎫 Mint:", mint.toBase58());
  console.log("👛 Recipient:", recipient.toBase58());
  console.log("🔐 Cipher ref:", cipherRef);
  console.log("🔑 Key handle:", keyHandle);
}

main().catch((err) => {
  console.error("Checkout mint failed:", err);
  process.exit(1);
});
