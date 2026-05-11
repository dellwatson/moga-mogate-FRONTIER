import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
import { getProvider } from "../../anchorClient.js";
import { solGiftConfig, updateSolGiftConfig } from "../../config.js";

async function main() {
  const provider = getProvider();
  const wallet: any = provider.wallet;
  const metaplex = Metaplex.make(provider.connection).use(
    keypairIdentity((wallet as any).payer),
  );

  if (!solGiftConfig.collection.uri) {
    throw new Error(
      "Set collection.uri in scripts/config/mogate_giftcard.config.json before creating the collection NFT",
    );
  }

  const { nft } = await metaplex.nfts().create({
    name: solGiftConfig.collection.name,
    symbol: solGiftConfig.collection.symbol,
    uri: solGiftConfig.collection.uri,
    sellerFeeBasisPoints: 0,
    isCollection: true,
    isMutable: true,
  });

  updateSolGiftConfig((config) => {
    config.collection.mint = nft.mint.address.toBase58();
  });

  console.log("collection mint:", nft.mint.address.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
