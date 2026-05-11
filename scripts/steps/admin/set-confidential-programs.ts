import { PublicKey } from "@solana/web3.js";
import { getConfigPda, getProgram, getProvider } from "../../anchorClient.js";
import { solGiftConfig } from "../../config.js";

async function main() {
  const program = getProgram();
  const provider = getProvider();
  const config = getConfigPda(program.programId);
  const encryptProgram = new PublicKey(
    process.env.ENCRYPT_PROGRAM_ID ||
      "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8",
  );
  const arciumProgram = new PublicKey(
    process.env.ARCIUM_PROGRAM_ID ||
      solGiftConfig.arcium.mxeProgramId ||
      "11111111111111111111111111111111",
  );

  const txSig = await program.methods
    .setConfidentialPrograms(encryptProgram, arciumProgram)
    .accountsStrict({
      authority: provider.wallet.publicKey,
      config,
    })
    .rpc();

  console.log("set_confidential_programs tx:", txSig);
  console.log("encrypt program:", encryptProgram.toBase58());
  console.log("arcium program:", arciumProgram.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
