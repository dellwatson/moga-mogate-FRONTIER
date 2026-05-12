import {
  AnchorProvider,
  Program,
  Wallet,
  setProvider,
} from "@coral-xyz/anchor";
import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { MogateGiftcard } from "../target/types/mogate_giftcard";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { loadSolGiftConfig } from "./config.js";

function expandHome(filePath: string): string {
  return filePath.startsWith("~/")
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;
}

function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];

  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) {
      throw new Error("invalid base58 character");
    }

    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

export function loadKeypairFromPath(keypairPath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(expandHome(keypairPath), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function loadKeypairFromInput(input: string, label: string): Keypair {
  const value = input.trim();
  if (!value) {
    throw new Error(`${label} is empty`);
  }

  if (value.startsWith("[") || value.startsWith("{")) {
    const parsed = JSON.parse(value);
    const secret = Array.isArray(parsed) ? parsed : parsed.secretKey;
    if (!Array.isArray(secret)) {
      throw new Error(`${label} JSON must be a secret-key array or { "secretKey": [...] }`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }

  const filePath = expandHome(value);
  if (fs.existsSync(filePath)) {
    return loadKeypairFromPath(filePath);
  }

  try {
    const secret = decodeBase58(value);
    if (secret.length !== 64) {
      throw new Error(`decoded secret length is ${secret.length}, expected 64`);
    }
    return Keypair.fromSecretKey(secret);
  } catch (err) {
    throw new Error(
      `${label} must be a keypair file path, JSON secret-key array, or base58-encoded 64-byte secret key. ` +
        `It cannot be a public address. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadKeypair(): Keypair {
  const config = loadSolGiftConfig();
  if (process.env.MINTER_PRIVATE_KEY) {
    return loadKeypairFromInput(process.env.MINTER_PRIVATE_KEY, "MINTER_PRIVATE_KEY");
  }

  const keypairPath =
    config.deployment.walletKeypair ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  return loadKeypairFromPath(keypairPath);
}

export function loadBackendKeypair(): Keypair {
  const config = loadSolGiftConfig();
  const backendKeypair = process.env.BACKEND_KEYPAIR || config.deployment.backendKeypair;
  return backendKeypair
    ? loadKeypairFromInput(backendKeypair, "BACKEND_KEYPAIR")
    : loadKeypair();
}

export function getProvider(): AnchorProvider {
  const rpcUrl =
    loadSolGiftConfig().network.rpcUrl || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(loadKeypair());
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  setProvider(provider);
  return provider;
}

export function getProgram(): Program<MogateGiftcard> {
  const provider = getProvider();
  const config = loadSolGiftConfig();
  const activeProgram = config.deployment.activeProgram || "combined";
  const idlName =
    activeProgram === "encrypt"
      ? "mogate_giftcard_encrypt"
      : activeProgram === "arcium"
        ? "mogate_giftcard_arcium"
        : "mogate_giftcard";
  const programId =
    activeProgram === "encrypt"
      ? config.deployment.programIds.encrypt
      : activeProgram === "arcium"
        ? config.deployment.programIds.arcium
        : config.deployment.programIds.combined || config.deployment.programId;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const idlPath = path.resolve(__dirname, `../target/idl/${idlName}.json`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as MogateGiftcard;
  if (programId) {
    (idl as unknown as { address: string }).address = programId;
  }
  return new Program<MogateGiftcard>(idl, provider);
}

export function getConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  )[0];
}

export function getGiftcardPda(
  programId: PublicKey,
  mint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("giftcard"), mint.toBuffer()],
    programId,
  )[0];
}

export function getFreezeAuthorityPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("freeze_authority")],
    programId,
  )[0];
}

export function getDecryptPermissionPda(
  programId: PublicKey,
  giftcard: PublicKey,
  grantee: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("decrypt_permission"),
      giftcard.toBuffer(),
      grantee.toBuffer(),
    ],
    programId,
  )[0];
}
