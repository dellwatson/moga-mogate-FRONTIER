import {
  Chain,
  DEVNET_PRE_ALPHA_GRPC_URL,
  createEncryptClient,
  encodeReadCiphertextMessage,
} from "@encrypt.xyz/pre-alpha-solana-client/grpc";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { ENCRYPT_EUINT128_FHE_TYPE, bufferToHex, hexToBuffer, leBytesToUint128, uint128ToLeBytes } from "./encoding.js";
import { loadSolGiftConfig } from "../config.js";

export const ENCRYPT_PRE_ALPHA_PROGRAM_ID = new PublicKey(
  "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8",
);

export type EncryptHandle = {
  ciphertextIdentifier: Uint8Array;
  fheType: number;
};

export function serializeEncryptHandle(handle: EncryptHandle): string {
  return bufferToHex(
    Buffer.concat([
      Buffer.from([handle.fheType]),
      Buffer.from(handle.ciphertextIdentifier),
    ]),
  );
}

export function deserializeEncryptHandle(hex: string): EncryptHandle {
  const bytes = hexToBuffer(hex);
  if (bytes.length < 2) throw new Error("invalid Encrypt handle");
  return {
    fheType: bytes[0],
    ciphertextIdentifier: bytes.subarray(1),
  };
}

function normalizeGrpcUrl(grpcUrl: string): string {
  return grpcUrl.replace(/^https?:\/\//, "");
}

function normalizeHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

async function discoverActiveNetworkPublicKeyHex(): Promise<string> {
  const config = loadSolGiftConfig();
  const connection = new Connection(
    config.network.rpcUrl || "https://api.devnet.solana.com",
    "confirmed",
  );
  const accounts = await connection.getProgramAccounts(ENCRYPT_PRE_ALPHA_PROGRAM_ID, {
    filters: [{ dataSize: 36 }],
  });
  const activeNetworkKey = accounts.find(({ account }) => {
    const data = account.data;
    return data.length === 36 && data[0] === 7 && data[1] === 1 && data[34] === 1;
  });

  if (!activeNetworkKey) {
    throw new Error(
      "Could not discover an active Encrypt NetworkEncryptionKey account on devnet; set encrypt.networkPublicKeyHex manually.",
    );
  }

  return Buffer.from(activeNetworkKey.account.data.subarray(2, 34)).toString("hex");
}

async function getNetworkPublicKeyHex(): Promise<string> {
  const config = loadSolGiftConfig();
  const configured =
    config.encrypt.networkPublicKeyHex || process.env.ENCRYPT_NETWORK_PUBLIC_KEY_HEX;
  if (configured) {
    const clean = normalizeHex(configured);
    if (Buffer.from(clean, "hex").length !== 32) {
      throw new Error("Encrypt network public key must be exactly 32 bytes of hex.");
    }
    return clean;
  }

  return discoverActiveNetworkPublicKeyHex();
}

export async function encryptUint128WithEncrypt(
  value: bigint,
  authorized: PublicKey,
): Promise<string> {
  const config = loadSolGiftConfig();
  const networkKeyHex = await getNetworkPublicKeyHex();

  const grpcUrl = normalizeGrpcUrl(
    config.encrypt.grpcUrl || process.env.ENCRYPT_GRPC_URL || DEVNET_PRE_ALPHA_GRPC_URL,
  );
  const client = createEncryptClient(grpcUrl);
  try {
    const plaintextFormat = Buffer.concat([
      Buffer.from([ENCRYPT_EUINT128_FHE_TYPE]),
      Buffer.from(uint128ToLeBytes(value)),
    ]);
    const result = await client.createInput({
      chain: Chain.Solana,
      inputs: [
        {
          ciphertextBytes: plaintextFormat,
          fheType: ENCRYPT_EUINT128_FHE_TYPE,
        },
      ],
      authorized: authorized.toBuffer(),
      networkEncryptionPublicKey: hexToBuffer(networkKeyHex),
    });
    return serializeEncryptHandle({
      ciphertextIdentifier: result.ciphertextIdentifiers[0],
      fheType: ENCRYPT_EUINT128_FHE_TYPE,
    });
  } finally {
    client.close();
  }
}

export async function decryptUint128WithEncrypt(
  handleHex: string,
  signer: Keypair,
): Promise<bigint> {
  const config = loadSolGiftConfig();
  const handle = deserializeEncryptHandle(handleHex);
  const reencryptionKeyHex = process.env.ENCRYPT_REENCRYPTION_KEY_HEX || "";
  const epoch = BigInt(process.env.ENCRYPT_EPOCH || "0");
  const message = encodeReadCiphertextMessage(
    Chain.Solana,
    handle.ciphertextIdentifier,
    hexToBuffer(reencryptionKeyHex),
    epoch,
  );
  const signature = Buffer.from(nacl.sign.detached(message, signer.secretKey));

  const client = createEncryptClient(
    normalizeGrpcUrl(config.encrypt.grpcUrl || process.env.ENCRYPT_GRPC_URL || DEVNET_PRE_ALPHA_GRPC_URL),
  );
  try {
    const result = await client.readCiphertext({
      message,
      signature,
      signer: signer.publicKey.toBuffer(),
    });
    return leBytesToUint128(result.value);
  } finally {
    client.close();
  }
}
