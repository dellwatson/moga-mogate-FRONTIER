import {
  AnchorProvider,
  Program,
  Wallet,
  setProvider,
} from "@coral-xyz/anchor";
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

export function loadKeypairFromPath(keypairPath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(expandHome(keypairPath), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function loadKeypair(): Keypair {
  const config = loadSolGiftConfig();
  const keypairPath =
    process.env.MINTER_PRIVATE_KEY ||
    config.deployment.walletKeypair ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  return loadKeypairFromPath(keypairPath);
}

export function loadBackendKeypair(): Keypair {
  const config = loadSolGiftConfig();
  const keypairPath =
    process.env.BACKEND_KEYPAIR || config.deployment.backendKeypair;
  return keypairPath ? loadKeypairFromPath(keypairPath) : loadKeypair();
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
