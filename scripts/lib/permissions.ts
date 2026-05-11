import { PublicKey } from "@solana/web3.js";
import { getDecryptPermissionPda, getGiftcardPda, getProgram } from "../anchorClient.js";

export async function assertDecryptPermission(
  mint: PublicKey,
  grantee: PublicKey,
  expectedBackend: number,
): Promise<void> {
  // This checks the Mogate app-level permission PDA. Real Encrypt/Arcium
  // network-enforced decrypt permission still needs program-level CPI support.
  const program = getProgram();
  const giftcardPda = getGiftcardPda(program.programId, mint);
  const permissionPda = getDecryptPermissionPda(
    program.programId,
    giftcardPda,
    grantee,
  );
  const permission = await program.account.decryptPermission.fetch(permissionPda);
  if (!permission.allowed) throw new Error("decrypt permission is not allowed");
  if (!permission.grantee.equals(grantee)) throw new Error("decrypt permission grantee mismatch");
  if (!permission.mint.equals(mint)) throw new Error("decrypt permission mint mismatch");
  if (permission.backend !== expectedBackend) {
    throw new Error(`decrypt permission backend mismatch: expected ${expectedBackend}`);
  }
}
