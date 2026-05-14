// import fs from "node:fs";
// import * as path from "node:path";
// import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
// import { getMint } from "@solana/spl-token";
// import {
//   getConfigPda,
//   getFreezeAuthorityPda,
//   getGiftcardPda,
//   getProgram as getGiftcardProgram,
//   getProvider,
// } from "../../anchorClient.js";
// import { solGiftConfig, updateSolGiftConfig } from "../../config.js";
// import { encryptUint128WithEncrypt } from "../../lib/encryptNetwork.js";
// import {
//   Program as AnchorProgram,
//   AnchorProvider,
//   setProvider,
//   Wallet,
// } from "@coral-xyz/anchor";

// // Import gateway program IDL (you'll need to generate this after building)
// const GATEWAY_PROGRAM_ID = new PublicKey(
//   "",
// );

// // Simple AES-GCM helper (same as original script)
// async function encryptGiftcodeWithAes(
//   giftcode: string,
// ): Promise<{ aesKeyHex: string; cipherRef: string }> {
//   const aesKeyBytes = crypto.getRandomValues(new Uint8Array(16));
//   const aesKeyHex = Array.from(aesKeyBytes)
//     .map((b) => b.toString(16).padStart(2, "0"))
//     .join("");

//   const encoder = new TextEncoder();
//   const giftcodeData = encoder.encode(giftcode);

//   const cryptoKey = await crypto.subtle.importKey(
//     "raw",
//     aesKeyBytes,
//     { name: "AES-GCM" },
//     false,
//     ["encrypt"],
//   );

//   const iv = crypto.getRandomValues(new Uint8Array(12));
//   const encryptedGiftcode = await crypto.subtle.encrypt(
//     { name: "AES-GCM", iv },
//     cryptoKey,
//     giftcodeData,
//   );

//   const encryptedPayload = new Uint8Array(
//     iv.length + encryptedGiftcode.byteLength,
//   );
//   encryptedPayload.set(iv);
//   encryptedPayload.set(new Uint8Array(encryptedGiftcode), iv.length);

//   const cipherRef = `giftcode_${Date.now()}.bin`;
//   const outPath = path.join(
//     path.dirname(new URL(import.meta.url).pathname),
//     cipherRef,
//   );
//   await fs.promises.writeFile(outPath, encryptedPayload);

//   return { aesKeyHex: `0x${aesKeyHex}`, cipherRef };
// }

// async function encryptAesKeyWithEncryptSdk(aesKeyHex: string): Promise<string> {
//   return encryptUint128WithEncrypt(
//     aesKeyHexToBigInt(aesKeyHex),
//     getGiftcardProgram().programId,
//   );
// }

// function aesKeyHexToBigInt(aesKeyHex: string): bigint {
//   const clean = aesKeyHex.startsWith("0x") ? aesKeyHex.slice(2) : aesKeyHex;
//   return BigInt("0x" + clean);
// }

// async function main() {
//   const { collection, giftcard } = solGiftConfig;
//   const { mint: mintCfg } = giftcard;

//   if (!collection.mint)
//     throw new Error(
//       "collection.mint is required; run step1:create-collection or set collection.mint in scripts/config/mogate_giftcard.config.json",
//     );
//   if (!mintCfg.uri)
//     throw new Error(
//       "giftcard.uri is required in scripts/config/mogate_giftcard.config.json",
//     );

//   const provider = getProvider();
//   const connection = provider.connection;
//   const wallet: any = provider.wallet;

//   console.log("[step2-gateway] Minter wallet:", wallet.publicKey.toBase58());

//   // 1) Generate / pick plaintext giftcode.
//   const giftcode =
//     mintCfg.plaintextGiftcode ||
//     `MOGATE_SOL_GIFTCODE_${Date.now().toString().slice(-6)}`;
//   console.log("Giftcode (plaintext, testing only):", giftcode);

//   // 2) AES-encrypt giftcode off-chain.
//   const { aesKeyHex, cipherRef } = await encryptGiftcodeWithAes(giftcode);
//   console.log("Encrypted giftcode saved to:", cipherRef);

//   // 3) Encrypt AES key with Encrypt/REFHE before minting.
//   const aesKeyBigInt = aesKeyHexToBigInt(aesKeyHex);
//   console.log("AES key (uint128 bigint):", aesKeyBigInt.toString());

//   const keyHandleHex = await encryptAesKeyWithEncryptSdk(aesKeyHex);
//   console.log("Encrypted AES key handle (hex):", keyHandleHex);

//   // 4) Generate new mint keypair for gateway minting
//   const mintKeypair = Keypair.generate();
//   console.log("New mint keypair:", mintKeypair.publicKey.toBase58());

//   const collectionMint = new PublicKey(collection.mint);
//   const giftcardProgram = getGiftcardProgram();
//   const configPda = getConfigPda(giftcardProgram.programId);
//   const freezeAuthorityPda = getFreezeAuthorityPda(giftcardProgram.programId);
//   const giftcardPda = getGiftcardPda(
//     giftcardProgram.programId,
//     mintKeypair.publicKey,
//   );

//   const tokenOwner = mintCfg.to
//     ? new PublicKey(mintCfg.to)
//     : provider.wallet.publicKey;

//   if (!tokenOwner.equals(provider.wallet.publicKey)) {
//     console.log(
//       `[step2-gateway] step3:unwrap must be signed by token owner ${tokenOwner.toBase58()}, not minter ${provider.wallet.publicKey.toBase58()}.`,
//     );
//   }

//   // Get associated token account address
//   const tokenAccountAddress = await anchor.utils.token.associatedAddress({
//     mint: mintKeypair.publicKey,
//     owner: tokenOwner,
//   });

//   const backend: number = mintCfg.backend.toLowerCase() === "arcium" ? 1 : 0; // 0 = Encrypt, 1 = Arcium

//   const keyHandleBytes = Buffer.from(
//     keyHandleHex.startsWith("0x") ? keyHandleHex.slice(2) : keyHandleHex,
//     "hex",
//   );

//   // 5) Initialize gateway program connection
//   // Note: You'll need to load the gateway program IDL here
//   // For now, this is a placeholder showing the structure
//   console.log("Gateway minting flow:");
//   console.log("- Payment verification would happen here");
//   console.log("- Gateway contract would call giftcard program via CPI");
//   console.log("- This provides atomic payment + minting");

//   // Example of how the gateway flow would work:
//   // 1. Client pays gateway contract
//   // 2. Gateway contract verifies payment
//   // 3. Gateway contract calls giftcard_program.gateway_mint_giftcard via CPI
//   // 4. All happens atomically in one transaction

//   // For demonstration, we'll show what the gateway would do:
//   console.log("Gateway would call gateway_mint_giftcard with:");
//   console.log("- mint:", mintKeypair.publicKey.toBase58());
//   console.log("- tokenOwner:", tokenOwner.toBase58());
//   console.log("- cipherRef:", cipherRef);
//   console.log("- backend:", backend);
//   console.log("- keyHandleBytes:", keyHandleBytes.toString("hex"));
//   console.log("- metadataUri:", mintCfg.uri);
//   console.log("- collectionMint:", collectionMint.toBase58());

//   // In a real implementation, you would:
//   // 1. Deploy the gateway program
//   // 2. Load its IDL
//   // 3. Call gateway.mint_with_payment() or gateway.owner_mint()
//   // 4. The gateway would handle the CPI to the giftcard program

//   console.log("\\nNote: To use gateway minting, you need to:");
//   console.log("1. Build and deploy the gateway program");
//   console.log("2. Set the gateway authority in the giftcard config");
//   console.log("3. Use the gateway program's mint functions");

//   // For now, let's just show the atomic minting as an alternative
//   console.log("\\nFalling back to atomic minting for demonstration...");

//   // This would be replaced with actual gateway calls
//   const txSig = await giftcardProgram.methods
//     .mintAndInitializeGiftcard(
//       cipherRef,
//       backend,
//       keyHandleBytes,
//       mintCfg.uri,
//       "Mogate Giftcard",
//       collection.symbol || "MOGA",
//       collectionMint,
//     )
//     .accountsStrict({
//       payer: wallet.publicKey,
//       tokenOwner: tokenOwner,
//       mint: mintKeypair.publicKey,
//       tokenAccount: tokenAccountAddress,
//       giftcard: giftcardPda,
//       config: configPda,
//       freezeAuthority: freezeAuthorityPda,
//       metadataProgram: new PublicKey(
//         "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
//       ),
//       instructions: new PublicKey(
//         "Sysvar1nstructions1111111111111111111111111",
//       ),
//       tokenProgram: new PublicKey(
//         "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
//       ),
//       associatedTokenProgram: new PublicKey(
//         "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
//       ),
//       systemProgram: SystemProgram.programId,
//       rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
//     })
//     .signers([mintKeypair, (wallet as any).payer])
//     .rpc();

//   console.log("Atomic mint tx (for comparison):", txSig);
//   console.log("Minted NFT:", mintKeypair.publicKey.toBase58());

//   updateSolGiftConfig((config) => {
//     config.giftcard.decrypt.mint = mintKeypair.publicKey.toBase58();
//     config.giftcard.decrypt.cipherRef = cipherRef;
//     config.giftcard.decrypt.giftcode = giftcode;
//     config.giftcard.decrypt.aesKeyHex = aesKeyHex;
//     config.giftcard.decrypt.backend = "encrypt";
//     config.giftcard.decrypt.keyHandleHex = keyHandleHex;
//     config.giftcard.decrypt.holderKeyHandleHex = "";
//     config.giftcard.decrypt.encryptPermissionTx = "";
//     config.giftcard.decrypt.mintTx = txSig;
//   });
// }

// main().catch((err) => {
//   console.error(err);
//   process.exit(1);
// });
