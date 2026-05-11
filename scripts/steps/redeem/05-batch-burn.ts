import {
  AccountMeta,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getConfigPda,
  getFreezeAuthorityPda,
  getGiftcardPda,
  getProgram,
  getProvider,
  loadBackendKeypair,
} from "../../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";
import { backendBatchBurnInstruction } from "../../lib/backendSignature.js";

async function main() {
  const mintList =
    process.env.MINTS ||
    process.env.MINT ||
    solGiftConfig.giftcard.decrypt.mint;
  const mints = mintList
    .split(",")
    .map((mint) => mint.trim())
    .filter(Boolean)
    .map((mint) => new PublicKey(mint));

  if (mints.length === 0) {
    throw new Error("Set MINTS, MINT, or giftcard.decrypt.mint in state");
  }

  const program = getProgram();
  const provider = getProvider();
  const config = getConfigPda(program.programId);
  const tokenOwner = provider.wallet.publicKey;
  const unsafeDemo = solGiftConfig.giftcard.mint.unsafeDemo;

  const accountGroups = await Promise.all(
    mints.map(async (mint) => ({
      giftcard: getGiftcardPda(program.programId, mint),
      mint,
      ownerTokenAccount: await getAssociatedTokenAddress(mint, tokenOwner),
      tokenOwner,
    })),
  );

  const remainingAccounts: AccountMeta[] = accountGroups.flatMap((group) => [
    { pubkey: group.giftcard, isWritable: true, isSigner: false },
    { pubkey: group.mint, isWritable: true, isSigner: false },
    { pubkey: group.ownerTokenAccount, isWritable: true, isSigner: false },
    { pubkey: group.tokenOwner, isWritable: false, isSigner: true },
  ]);

  const accounts = {
    authority: provider.wallet.publicKey,
    config,
    freezeAuthority: getFreezeAuthorityPda(program.programId),
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  const txSig = await (unsafeDemo
    ? program.methods.unsafeBatchBurn().accountsStrict(accounts)
    : program.methods
        .batchBurn()
        .preInstructions([
          backendBatchBurnInstruction(loadBackendKeypair(), {
            programId: program.programId,
            config,
            accountGroups,
          }),
        ])
        .accountsStrict(accounts)
  )
    .remainingAccounts(remainingAccounts)
    .rpc();

  console.log("batch_burn tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.burnTx = txSig;
    config.giftcard.decrypt.cipherRef = "";
    config.giftcard.decrypt.keyHandleHex = "";
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
