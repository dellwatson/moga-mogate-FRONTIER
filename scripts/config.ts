import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectConfigPath = path.join(
  __dirname,
  "config",
  "mogate_giftcard.config.json",
);
export const runStatePath = path.join(
  __dirname,
  "config",
  "mogate_giftcard.state.json",
);

export type MogateGiftcardProjectConfig = {
  deployment: {
    programId: string;
    programIds: {
      combined: string;
      encrypt: string;
      arcium: string;
    };
    activeProgram: "combined" | "encrypt" | "arcium" | string;
    cluster: "localnet" | "devnet" | "mainnet-beta" | string;
    rpcUrl: string;
    walletKeypair: string;
    backendKeypair: string;
  };
  collection: {
    mint: string;
    name: string;
    symbol: string;
    uri: string;
  };
  giftcard: {
    to: string;
    uri: string;
    backend: "encrypt" | "arcium" | string;
    expiryIso: string;
    plaintextGiftcode: string;
    unsafeDemo: boolean;
  };
  encrypt: {
    grpcUrl: string;
    networkPublicKeyHex: string;
  };
  arcium: {
    mxeProgramId: string;
  };
};

export type MogateGiftcardRunState = {
  backend: {
    authority: string;
  };
  collection: {
    mint: string;
  };
  giftcard: {
    mint: string;
    cipherRef: string;
    giftcode: string;
    aesKeyHex: string;
    backend: string;
    keyHandleHex: string;
    unwrapTx: string;
    mintTx: string;
    cleanupTx: string;
    burnTx: string;
  };
};

export type SolGiftConfig = {
  deployment: MogateGiftcardProjectConfig["deployment"];
  network: {
    cluster: string;
    rpcUrl: string;
  };
  collection: MogateGiftcardProjectConfig["collection"];
  backend: MogateGiftcardRunState["backend"];
  giftcard: {
    mint: MogateGiftcardProjectConfig["giftcard"];
    decrypt: MogateGiftcardRunState["giftcard"];
  };
  encrypt: MogateGiftcardProjectConfig["encrypt"];
  arcium: MogateGiftcardProjectConfig["arcium"];
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadProjectConfig(): MogateGiftcardProjectConfig {
  return readJson<MogateGiftcardProjectConfig>(projectConfigPath);
}

export function loadRunState(): MogateGiftcardRunState {
  return readJson<MogateGiftcardRunState>(runStatePath);
}

export function saveRunState(state: MogateGiftcardRunState): void {
  writeJson(runStatePath, state);
}

export function loadSolGiftConfig(): SolGiftConfig {
  const project = loadProjectConfig();
  const state = loadRunState();
  return {
    deployment: project.deployment,
    network: {
      cluster: project.deployment.cluster,
      rpcUrl: project.deployment.rpcUrl,
    },
    collection: {
      ...project.collection,
      mint: state.collection.mint || project.collection.mint,
    },
    backend: state.backend,
    giftcard: {
      mint: project.giftcard,
      decrypt: state.giftcard,
    },
    encrypt: project.encrypt,
    arcium: project.arcium,
  };
}

export function updateSolGiftConfig(
  update: (config: SolGiftConfig) => void,
): SolGiftConfig {
  const project = loadProjectConfig();
  const state = loadRunState();
  const config = loadSolGiftConfig();
  update(config);

  state.backend = config.backend;
  state.collection.mint = config.collection.mint;
  state.giftcard = config.giftcard.decrypt;
  saveRunState(state);

  return {
    ...config,
    deployment: project.deployment,
    network: {
      cluster: project.deployment.cluster,
      rpcUrl: project.deployment.rpcUrl,
    },
  };
}

export const solGiftConfig = loadSolGiftConfig();
