import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getConfigPda,
  getFreezeAuthorityPda,
  getGiftcardPda,
  loadBackendKeypair,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";
import { backendBurnInstruction } from "../../lib/backendSignature.js";

async function main() {
  const mintRaw = process.env.MINT || solGiftConfig.giftcard.decrypt.mint;
  if (!mintRaw) throw new Error("MINT env var is required");

  const program = getProgram();
  const provider = getProvider();
  const mint = new PublicKey(mintRaw);
  const tokenOwner = provider.wallet.publicKey;
  const ownerTokenAccount = await getAssociatedTokenAddress(mint, tokenOwner);
  const config = getConfigPda(program.programId);
  const giftcard = getGiftcardPda(program.programId, mint);
  const unsafeDemo = solGiftConfig.giftcard.mint.unsafeDemo;

  const accounts = {
    authority: provider.wallet.publicKey,
    tokenOwner,
    config,
    giftcard,
    mint,
    ownerTokenAccount,
    freezeAuthority: getFreezeAuthorityPda(program.programId),
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  const txSig = await (unsafeDemo
    ? program.methods.unsafeBurnRedeemed().accountsStrict({
        ...accounts,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
    : program.methods
        .burnRedeemed()
        .preInstructions([
          backendBurnInstruction(loadBackendKeypair(), {
            programId: program.programId,
            config,
            giftcard,
            mint,
            tokenOwner,
          }),
        ])
        .accountsStrict({
          ...accounts,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
  ).rpc();

  console.log("burn_redeemed tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.mint = mint.toBase58();
    config.giftcard.decrypt.burnTx = txSig;
    config.giftcard.decrypt.cipherRef = "";
    config.giftcard.decrypt.keyHandleHex = "";
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
