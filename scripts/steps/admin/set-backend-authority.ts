import { PublicKey } from "@solana/web3.js";
import { getConfigPda, getProgram, getProvider, loadBackendKeypair } from "../../anchorClient.js";
import { updateSolGiftConfig } from "../../config.js";

async function main() {
  const program = getProgram();
  const provider = getProvider();
  const config = getConfigPda(program.programId);
  const backendAuthority = process.env.BACKEND_AUTHORITY
    ? new PublicKey(process.env.BACKEND_AUTHORITY)
    : loadBackendKeypair().publicKey;

  const txSig = await program.methods
    .setBackendAuthority(backendAuthority)
    .accountsStrict({
      authority: provider.wallet.publicKey,
      config,
    })
    .rpc();

  console.log("set_backend_authority tx:", txSig);
  console.log("backend authority:", backendAuthority.toBase58());
  updateSolGiftConfig((state) => {
    state.backend.authority = backendAuthority.toBase58();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
