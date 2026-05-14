import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getConfigPda,
  getDecryptPermissionPda,
  getGiftcardPda,
  getProgram,
  getProvider,
} from "../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../config.js";
import {
  ENCRYPT_EUINT128_FHE_TYPE,
  bufferToHex,
  hexToBuffer,
} from "./encoding.js";

const ENCRYPT_PRE_ALPHA_PROGRAM_ID =
  "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8";
// Must match ENCRYPT_CPI_AUTHORITY_SEED in the on-chain program (b"__encrypt_cpi_authority")
const ENCRYPT_CPI_AUTHORITY_SEED = "__encrypt_cpi_authority";

function keyHandleToPublicKey(keyHandleHex: string): PublicKey {
  const bytes = hexToBuffer(keyHandleHex);
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

function copyHandleForGrantee(
  sourceHandleHex: string,
  granteeCiphertext: PublicKey,
): string {
  const source = hexToBuffer(sourceHandleHex);
  const fheType = source.length === 33 ? source[0] : ENCRYPT_EUINT128_FHE_TYPE;
  return bufferToHex(
    Buffer.concat([Buffer.from([fheType]), granteeCiphertext.toBuffer()]),
  );
}

export async function copyEncryptCiphertextForCurrentHolder(): Promise<{
  txSig: string;
  sourceCiphertext: PublicKey;
  granteeCiphertext: PublicKey;
  holderKeyHandleHex: string;
}> {
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
  const encryptConfig = process.env.ENCRYPT_CONFIG
    ? new PublicKey(process.env.ENCRYPT_CONFIG)
    : PublicKey.findProgramAddressSync(
        [Buffer.from("encrypt_config")],
        encryptProgram,
      )[0];
  const deposit = process.env.ENCRYPT_DEPOSIT
    ? new PublicKey(process.env.ENCRYPT_DEPOSIT)
    : PublicKey.findProgramAddressSync(
        [Buffer.from("encrypt_deposit"), grantee.toBuffer()],
        encryptProgram,
      )[0];
  const networkKeyHex = solGiftConfig.encrypt.networkPublicKeyHex;
  if (!networkKeyHex) {
    throw new Error(
      "encrypt.networkPublicKeyHex is required to derive the Encrypt NetworkEncryptionKey PDA.",
    );
  }
  const networkEncryptionKey = process.env.ENCRYPT_NETWORK_ENCRYPTION_KEY
    ? new PublicKey(process.env.ENCRYPT_NETWORK_ENCRYPTION_KEY)
    : PublicKey.findProgramAddressSync(
        [Buffer.from("network_encryption_key"), hexToBuffer(networkKeyHex)],
        encryptProgram,
      )[0];
  const eventAuthority = process.env.ENCRYPT_EVENT_AUTHORITY
    ? new PublicKey(process.env.ENCRYPT_EVENT_AUTHORITY)
    : PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        encryptProgram,
      )[0];
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

  const holderKeyHandleHex = copyHandleForGrantee(
    solGiftConfig.giftcard.decrypt.keyHandleHex,
    granteeCiphertext.publicKey,
  );
  updateSolGiftConfig((config) => {
    config.giftcard.decrypt.holderKeyHandleHex = holderKeyHandleHex;
    config.giftcard.decrypt.encryptPermissionTx = txSig;
  });

  return {
    txSig,
    sourceCiphertext,
    granteeCiphertext: granteeCiphertext.publicKey,
    holderKeyHandleHex,
  };
}
