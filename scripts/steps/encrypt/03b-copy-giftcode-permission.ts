import { copyEncryptCiphertextForCurrentHolder } from "../../lib/encryptPermission.js";

async function main() {
  const result = await copyEncryptCiphertextForCurrentHolder();

  console.log("encrypt copy_ciphertext tx:", result.txSig);
  console.log("source ciphertext:", result.sourceCiphertext.toBase58());
  console.log("grantee ciphertext:", result.granteeCiphertext.toBase58());
  console.log("holder key handle:", result.holderKeyHandleHex);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
