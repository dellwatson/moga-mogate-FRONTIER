import { SystemProgram } from "@solana/web3.js";
import {
  getConfigPda,
  getProgram,
  getProvider,
  loadBackendKeypair,
} from "../../anchorClient.js";
import { updateSolGiftConfig } from "../../config.js";

async function main() {
  const program = getProgram();
  const provider = getProvider();
  const config = getConfigPda(program.programId);
  const backendAuthority = loadBackendKeypair().publicKey;

  const txSig = await program.methods
    .initializeConfig(backendAuthority, backendAuthority) // Use same for both for now
    .accountsStrict({
      owner: provider.wallet.publicKey,
      config,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("initialize_config tx:", txSig);
  console.log("config:", config.toBase58());
  console.log("backend authority:", backendAuthority.toBase58());
  updateSolGiftConfig((state) => {
    state.backend.authority = backendAuthority.toBase58();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
