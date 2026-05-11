import { SystemProgram, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  getConfigPda,
  getFreezeAuthorityPda,
  getGiftcardPda,
  loadBackendKeypair,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import { backendInitializeInstruction } from "../../lib/backendSignature.js";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0) {
    return new Uint8Array();
  }
  if (clean.length % 2 !== 0) {
    throw new Error("KEY_HANDLE_HEX must have even length");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function main() {
  const mintStr = process.env.MINT;
  const cipherRef = process.env.CIPHER_REF || "";
  const backendStr = process.env.BACKEND || "refhe";
  const keyHandleHex = process.env.KEY_HANDLE_HEX || "";
  const unsafeDemo = (process.env.UNSAFE_DEMO || "false").toLowerCase() === "true";

  if (!mintStr) {
    throw new Error("MINT env var (mint address) is required");
  }

  const backend = backendStr.toLowerCase() === "arcium" ? 1 : 0; // 0 = REFHE/Encrypt, 1 = Arcium (convention)

  const keyHandleBytes = hexToBytes(keyHandleHex);

  const program = getProgram();
  const provider = getProvider();
  const mint = new PublicKey(mintStr);

  const configPda = getConfigPda(program.programId);
  const giftcardPda = getGiftcardPda(program.programId, mint);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);

  const keyHandle = Buffer.from(keyHandleBytes);
  const accounts = {
    authority: provider.wallet.publicKey,
    config: configPda,
    mint,
    giftcard: giftcardPda,
    freezeAuthority: freezeAuthorityPda,
    systemProgram: SystemProgram.programId,
  };

  const txSig = await (unsafeDemo
    ? program.methods.unsafeInitializeGiftcard(cipherRef, backend, keyHandle).accountsStrict(accounts)
    : program.methods
        .initializeGiftcard(cipherRef, backend, keyHandle)
        .preInstructions([
          backendInitializeInstruction(loadBackendKeypair(), {
            programId: program.programId,
            config: configPda,
            mint,
            backend,
            cipherRef,
            keyHandle,
          }),
        ])
        .accountsStrict({
          ...accounts,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
  ).rpc();

  console.log("initialize_giftcard tx:", txSig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
