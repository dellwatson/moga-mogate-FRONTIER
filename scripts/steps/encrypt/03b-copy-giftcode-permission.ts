import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getConfigPda,
  getDecryptPermissionPda,
  getGiftcardPda,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";

const ENCRYPT_PRE_ALPHA_PROGRAM_ID = "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8";
const ENCRYPT_CPI_AUTHORITY_SEED = "__encrypt_cpi_authority";

function requirePublicKey(name: string, value: string | undefined): PublicKey {
  if (!value) {
    throw new Error(`${name} is required for Encrypt copy_ciphertext CPI`);
  }
  return new PublicKey(value);
}

function keyHandleToPublicKey(keyHandleHex: string): PublicKey {
  const bytes = Buffer.from(keyHandleHex, "hex");
  if (bytes.length === 33) {
    return new PublicKey(bytes.subarray(1));
  }
  if (bytes.length !== 32) {
    throw new Error(
      `giftcard keyHandleHex must be a 32-byte ciphertext id or 33-byte fheType+ciphertext id; got ${bytes.length} bytes`,
    );
  }
  return new PublicKey(bytes);
}

async function main() {
  const program = getProgram();
  const provider = getProvider();
  const mint = new PublicKey(solGiftConfig.giftcard.decrypt.mint);
  const giftcard = getGiftcardPda(program.programId, mint);
  const config = getConfigPda(program.programId);
  const grantee = provider.wallet.publicKey;
  const decryptPermission = getDecryptPermissionPda(
    program.programId,
    giftcard,
    grantee,
  );

  const sourceCiphertext = keyHandleToPublicKey(
    solGiftConfig.giftcard.decrypt.keyHandleHex,
  );
  const granteeCiphertext = Keypair.generate();
  const encryptProgram = new PublicKey(
    process.env.ENCRYPT_PROGRAM_ID || ENCRYPT_PRE_ALPHA_PROGRAM_ID,
  );
  const encryptConfig = requirePublicKey(
    "ENCRYPT_CONFIG",
    process.env.ENCRYPT_CONFIG,
  );
  const deposit = requirePublicKey("ENCRYPT_DEPOSIT", process.env.ENCRYPT_DEPOSIT);
  const networkEncryptionKey = requirePublicKey(
    "ENCRYPT_NETWORK_ENCRYPTION_KEY",
    process.env.ENCRYPT_NETWORK_ENCRYPTION_KEY,
  );
  const eventAuthority = requirePublicKey(
    "ENCRYPT_EVENT_AUTHORITY",
    process.env.ENCRYPT_EVENT_AUTHORITY,
  );
  const [cpiAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from(ENCRYPT_CPI_AUTHORITY_SEED)],
    program.programId,
  );

  const txSig = await program.methods
    .encryptCopyGiftcodeForGrantee()
    .accountsStrict({
      grantee,
      config,
      giftcard,
      decryptPermission,
      sourceCiphertext,
      granteeCiphertext: granteeCiphertext.publicKey,
      encryptProgram,
      encryptConfig,
      deposit,
      cpiAuthority,
      callerProgram: program.programId,
      networkEncryptionKey,
      payer: grantee,
      eventAuthority,
      systemProgram: SystemProgram.programId,
    })
    .signers([granteeCiphertext])
    .rpc();

  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.cipherRef = granteeCiphertext.publicKey.toBase58();
  });

  console.log("encrypt copy_ciphertext tx:", txSig);
  console.log("source ciphertext:", sourceCiphertext.toBase58());
  console.log("grantee ciphertext:", granteeCiphertext.publicKey.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
