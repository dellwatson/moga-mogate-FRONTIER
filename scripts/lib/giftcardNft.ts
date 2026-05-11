import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  AuthorityType,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
} from "@solana/web3.js";

export type CreateGiftcardNftArgs = {
  connection: Connection;
  payer: Keypair;
  tokenOwner: PublicKey;
  freezeAuthority: PublicKey;
  collectionMint: PublicKey;
  uri: string;
  name: string;
  symbol: string;
};

export type CreatedGiftcardNft = {
  mint: PublicKey;
  tokenAccount: PublicKey;
};

/**
 * Creates a one-of-one SPL mint whose freeze authority is already the program
 * PDA, then attaches Metaplex metadata to that existing mint.
 *
 * We intentionally do not create a Master Edition here. The Token Metadata
 * program moves freeze authority to the Master Edition PDA, which prevents this
 * program from enforcing soulbound freezes during unwrap. Instead we mint a
 * fixed-supply token, revoke mint authority, and keep freeze authority on the
 * program PDA.
 */
export async function createGiftcardNftWithProgramFreezeAuthority({
  connection,
  payer,
  tokenOwner,
  freezeAuthority,
  collectionMint,
  uri,
  name,
  symbol,
}: CreateGiftcardNftArgs): Promise<CreatedGiftcardNft> {
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    freezeAuthority,
    0,
  );

  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    tokenOwner,
  );

  await mintTo(connection, payer, mint, tokenAccount.address, payer, 1);

  const [metadata] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  );
  const metadataIx = createCreateMetadataAccountV3Instruction(
    {
      metadata,
      mint,
      mintAuthority: payer.publicKey,
      payer: payer.publicKey,
      updateAuthority: payer.publicKey,
    },
    {
      createMetadataAccountArgsV3: {
        data: {
          name,
          symbol,
          uri,
          sellerFeeBasisPoints: 0,
          creators: [
            {
              address: payer.publicKey,
              verified: true,
              share: 100,
            },
          ],
          collection: {
            verified: false,
            key: collectionMint,
          },
          uses: null,
        },
        isMutable: true,
        collectionDetails: null,
      },
    },
  );

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(metadataIx),
    [payer],
    { commitment: "confirmed" },
  );

  await setAuthority(
    connection,
    payer,
    mint,
    payer.publicKey,
    AuthorityType.MintTokens,
    null,
  );

  return {
    mint,
    tokenAccount: tokenAccount.address,
  };
}
