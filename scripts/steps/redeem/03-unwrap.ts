import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getConfigPda,
  getDecryptPermissionPda,
  getFreezeAuthorityPda,
  getGiftcardPda,
  getProgram,
  getProvider,
} from "../../anchorClient.js";
import {
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";

async function findLargestTokenHolder(
  connection: ReturnType<typeof getProvider>["connection"],
  mint: PublicKey,
): Promise<{ owner: PublicKey; tokenAccount: PublicKey } | null> {
  const largest = await connection.getTokenLargestAccounts(mint);
  const account = largest.value.find((item) => item.uiAmount === 1);
  if (!account) return null;

  const parsed = await connection.getParsedAccountInfo(account.address);
  const data = parsed.value?.data;
  if (!data || typeof data === "string" || !("parsed" in data)) return null;

  const owner = data.parsed?.info?.owner;
  if (!owner) return null;

  return {
    owner: new PublicKey(owner),
    tokenAccount: account.address,
  };
}

async function main() {
  const mintStr = process.env.MINT || solGiftConfig.giftcard.decrypt.mint;
  if (!mintStr) {
    throw new Error("MINT env var (mint address) is required");
  }

  const program = getProgram();
  const provider = getProvider();

  const mint = new PublicKey(mintStr);
  const owner = provider.wallet.publicKey;
  let ownerTokenAccount = await getAssociatedTokenAddress(mint, owner);

  try {
    const tokenAccount = await getAccount(
      provider.connection,
      ownerTokenAccount,
    );
    if (tokenAccount.amount !== 1n) {
      throw new Error(
        `Current signer ATA ${ownerTokenAccount.toBase58()} holds ${tokenAccount.amount.toString()} tokens for ${mint.toBase58()}, expected 1.`,
      );
    }
  } catch (err) {
    const holder = await findLargestTokenHolder(provider.connection, mint);
    const configuredRecipient = solGiftConfig.giftcard.mint.to || "not set";

    if (holder && holder.owner.equals(owner)) {
      ownerTokenAccount = holder.tokenAccount;
      console.log(
        `Using holder token account ${ownerTokenAccount.toBase58()} for unwrap; signer matches on-chain holder.`,
      );
    } else {
      throw new Error(
        [
          `Current signer ${owner.toBase58()} does not own giftcard mint ${mint.toBase58()}.`,
          `Expected signer ATA ${ownerTokenAccount.toBase58()} is not initialized or does not hold the NFT.`,
          holder
            ? `Current on-chain holder is ${holder.owner.toBase58()} at token account ${holder.tokenAccount.toBase58()}.`
            : "Could not find a token account holding supply 1 for this mint.",
          `Configured giftcard.to is ${configuredRecipient}. Run step3 with the holder keypair, or set giftcard.to to your signer and mint a new giftcard.`,
          `Original token-account check: ${err instanceof Error ? err.message : String(err)}`,
        ].join("\n"),
      );
    }
  }

  const configPda = getConfigPda(program.programId);
  const giftcardPda = getGiftcardPda(program.programId, mint);
  const freezeAuthorityPda = getFreezeAuthorityPda(program.programId);
  const decryptPermissionPda = getDecryptPermissionPda(
    program.programId,
    giftcardPda,
    owner,
  );

  const giftcardAccount = await program.account.giftcard.fetch(giftcardPda);
  const permissionAccount =
    await provider.connection.getAccountInfo(decryptPermissionPda);

  if (giftcardAccount.unwrapped || permissionAccount) {
    const redeemer = giftcardAccount.redeemer?.toBase58?.() || "unknown";
    if (!giftcardAccount.redeemer.equals(owner)) {
      throw new Error(
        [
          `Giftcard ${mint.toBase58()} is already unwrapped by ${redeemer}.`,
          `Current signer is ${owner.toBase58()}.`,
          `Decrypt permission PDA: ${decryptPermissionPda.toBase58()}.`,
        ].join("\n"),
      );
    }

    console.log("Giftcard is already unwrapped.");
    console.log("mint:", mint.toBase58());
    console.log("redeemer:", redeemer);
    console.log("decrypt permission:", decryptPermissionPda.toBase58());
    updateSolGiftConfig((config) => {
      config.giftcard.decrypt.mint = mint.toBase58();
    });
    return;
  }

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
