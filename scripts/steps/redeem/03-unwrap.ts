import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getConfigPda,
  getDecryptPermissionPda,
  getFreezeAuthorityPda,
  getGiftcardPda,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";

async function main() {
  const mintStr = process.env.MINT || solGiftConfig.giftcard.decrypt.mint;
  if (!mintStr) {
    throw new Error("MINT env var (mint address) is required");
  }

  const program = getProgram();
  const provider = getProvider();

  const mint = new PublicKey(mintStr);
  const owner = provider.wallet.publicKey;
  const ownerTokenAccount = await getAssociatedTokenAddress(mint, owner);

  const configPda = getConfigPda(program.programId);
  const giftcardPda = getGiftcardPda(program.programId, mint);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);
  const decryptPermissionPda = getDecryptPermissionPda(
    program.programId,
    giftcardPda,
    owner,
  );

  const txSig = await program.methods
    .unwrap()
    .accountsStrict({
      giftcard: giftcardPda,
      config: configPda,
      mint,
      owner,
      ownerTokenAccount,
      freezeAuthority: freezeAuthorityPda,
      decryptPermission: decryptPermissionPda,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("unwrap tx:", txSig);
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.mint = mint.toBase58();
    config.giftcard.decrypt.unwrapTx = txSig;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
