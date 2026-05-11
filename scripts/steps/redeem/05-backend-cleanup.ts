import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  getConfigPda,
  getGiftcardPda,
  getProgram,
  getProvider,
  loadBackendKeypair,
} from "../../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";
import { backendCleanupInstruction } from "../../lib/backendSignature.js";

async function main() {
  const mintRaw = process.env.MINT || solGiftConfig.giftcard.decrypt.mint;
  if (!mintRaw) throw new Error("Set MINT or giftcard.decrypt.mint in state");

  const program = getProgram();
  const provider = getProvider();
  const mint = new PublicKey(mintRaw);
  const config = getConfigPda(program.programId);
  const giftcard = getGiftcardPda(program.programId, mint);
  const unsafeDemo = solGiftConfig.giftcard.mint.unsafeDemo;

  const txSig = unsafeDemo
    ? await program.methods
        .unsafeBackendCleanup()
        .accountsStrict({
          giftcard,
          config,
        })
        .rpc()
    : await program.methods
        .backendCleanup()
        .preInstructions([
          backendCleanupInstruction(loadBackendKeypair(), {
            programId: program.programId,
            config,
            giftcard,
            mint,
          }),
        ])
        .accountsStrict({
          authority: provider.wallet.publicKey,
          config,
          giftcard,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();

  console.log("backend_cleanup tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.cipherRef = "";
    config.giftcard.decrypt.keyHandleHex = "";
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
