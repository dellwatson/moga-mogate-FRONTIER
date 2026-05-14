# Mogate Solana NFT Giftcard Steps

## ⚠️ Deployment Cost Warning

- **Encrypt backend**: Only requires deploying the `mogate_giftcard` program (minimal devnet SOL).
- **Arcium backend**: Requires deploying an additional **MXE** on Solana devnet, which costs **~3 SOL** for rent and setup. This is a one-time cost per cluster offset. For testing, the Encrypt backend is cheaper and simpler.

This project has two config files:

- `scripts/config/mogate_giftcard.config.json`: edit this by hand before running scripts.
- `scripts/config/mogate_giftcard.state.json`: scripts update this after each step. Do not use it as your main config.

## Key Concepts

### Program ID

The Solana program id is the deployed address of `mogate_giftcard`.

It must match in three places:

- `programs/mogate_giftcard/src/lib.rs` -> `declare_id!(...)`
- `Anchor.toml` -> `[programs.devnet].mogate_giftcard`
- `scripts/config/mogate_giftcard.config.json` -> `deployment.programId`

The first two are used by Anchor/build/deploy. The config JSON value is used by scripts and can override the IDL address loaded by the TypeScript client.

For the split programs, use:

- `deployment.programIds.combined` for `mogate_giftcard`.
- `deployment.programIds.encrypt` for `mogate_giftcard_encrypt`.
- `deployment.programIds.arcium` for `mogate_giftcard_arcium`.
- `deployment.activeProgram` to pick which IDL/program the scripts use.

### RPC URL

For devnet, use a devnet RPC:

```json
"rpcUrl": "https://api.devnet.solana.com"
```

You can replace it with a Helius/QuickNode/Triton devnet endpoint. Use `http://localhost:8899` only when running a local validator.

### Encrypt gRPC And Network Key

For Encrypt pre-alpha devnet, keep:

```json
"encrypt": {
  "grpcUrl": "pre-alpha-dev-1.encrypt.ika-network.net:443",
  "networkPublicKeyHex": "5555555555555555555555555555555555555555555555555555555555555555"
}
```

The script also auto-discovers the active `NetworkEncryptionKey` account from
devnet if `networkPublicKeyHex` is blank. The gRPC URL should be `host:port`;
do not include `https://`.

### Collection NFT

The collection NFT is a Metaplex parent collection marker for wallets/marketplaces. The giftcard program does not need permission from the collection NFT.

Each individual giftcard mint is created with its SPL Token freeze authority set to the program PDA from the start. The mint scripts also revoke mint authority after minting exactly one token. That freeze authority is what lets `unwrap` make the token soulbound by freezing the holder token account.

### Giftcode / Voucher Code

`giftcard.plaintextGiftcode` is the giftcode or voucher code.

It is for local/devnet testing only. In production, generate the voucher code off-chain, encrypt it, and do not commit the plaintext into git.

### Backend Signer

Production init, cleanup, and burn instructions require a backend Ed25519 signature from `Config.backend_authority`.

`unsafeDemo: true` tells scripts to use unsafe demo instructions without backend signatures. Use this for devnet demos only.

## Editable Config

Edit `scripts/config/mogate_giftcard.config.json`:

```json
{
  "deployment": {
    "programId": "YOUR_PROGRAM_ID",
    "programIds": {
      "combined": "YOUR_COMBINED_PROGRAM_ID",
      "encrypt": "YOUR_ENCRYPT_ONLY_PROGRAM_ID",
      "arcium": "YOUR_ARCIUM_ONLY_PROGRAM_ID"
    },
    "activeProgram": "combined",
    "cluster": "devnet",
    "rpcUrl": "https://api.devnet.solana.com",
    "walletKeypair": "~/.config/solana/id.json",
    "backendKeypair": ""
  },
  "collection": {
    "mint": "",
    "name": "Mogate Giftcards",
    "symbol": "MOGA",
    "uri": "https://your-collection-metadata.json"
  },
  "giftcard": {
    "to": "RECIPIENT_WALLET",
    "uri": "https://your-giftcard-metadata.json",
    "backend": "encrypt",
    "expiryIso": "2026-12-31T23:59:59.000Z",
    "plaintextGiftcode": "DEVNET-TEST-CODE",
    "unsafeDemo": true
  }
}
```

For production signature testing, set `unsafeDemo` to `false` and set `deployment.backendKeypair` to the backend signer keypair path.

## Step 0: Build And Deploy Program

```bash
bun run build:program
bun run deploy:program
```

After deployment, make sure the deployed program id is copied into:

- `programs/mogate_giftcard/src/lib.rs`
- `Anchor.toml`
- `scripts/config/mogate_giftcard.config.json`

Then rebuild if you changed `declare_id!`:

```bash
bun run build:program
```

## Step 0b: Initialize Program Config

This creates the `Config` PDA and stores:

- `owner`: admin wallet
- `backend_authority`: backend signer wallet
- `encrypt_program`: Encrypt devnet program id
- `arcium_program`: empty until configured

```bash
bun run init:config
```

To update the backend signer later:

```bash
bun run set:backend-authority
```

## Step 0c: Configure Confidential Programs

The config stores the external Encrypt and Arcium program ids used by the
`grant_confidential_permission_cpi` hook.

```bash
bun run set:confidential-programs
```

By default, Encrypt uses the current pre-alpha devnet program id from the
Encrypt docs. Set `ARCIUM_PROGRAM_ID` or `arcium.mxeProgramId` before this step
when using the Arcium flow.

## Step 1: Create Collection NFT

Set `collection.uri` first, then run:

```bash
bun run step1:create-collection
```

The script writes the collection mint into `scripts/config/mogate_giftcard.state.json`.

## Step 2: Mint Giftcard NFT

Encrypt backend:

```bash
bun run step2:mint:encrypt
```

Arcium backend:

```bash
bun run step2:mint:arcium
```

This mints one fixed-supply giftcard token to `giftcard.to`, attaches Metaplex metadata, sets freeze authority to the program PDA, encrypts/stores giftcode references, initializes the giftcard PDA, and writes latest mint/cipher details into state.

## Step 3: Unwrap

The holder unwraps the NFT into a soulbound giftcard:

```bash
bun run step3:unwrap
```

Run this step with the keypair that owns `giftcard.to`. If `giftcard.to` is not
the current script wallet, update `deployment.walletKeypair` or run with the
holder keypair before calling `step3:unwrap`.

This freezes the holder token account and creates the decrypt permission PDA.

For Encrypt, also copy the program-authorized ciphertext to a holder-authorized
ciphertext through the Encrypt program:

```bash
ENCRYPT_CONFIG=... \
ENCRYPT_DEPOSIT=... \
ENCRYPT_NETWORK_ENCRYPTION_KEY=... \
ENCRYPT_EVENT_AUTHORITY=... \
bun run step3:encrypt-permission
```

## Step 4: Decrypt

Encrypt backend:

```bash
bun run step4:decrypt:encrypt
```

Arcium backend:

```bash
bun run step4:decrypt:arcium
```

The Encrypt flow should use the holder-authorized ciphertext copy produced by
`step3:encrypt-permission`. The local decrypt script still exists for devnet
testing, but production should not trust only the Mogate `DecryptPermission`
PDA.

## Step 5: Cleanup Or Burn

If the merchant consumed the code but you want to keep the NFT marker:

```bash
bun run cleanup:backend
```

If the merchant consumed the code and you want to burn the soulbound NFT and clear encrypted data:

```bash
bun run burn:redeemed
```

Batch burn:

```bash
MINTS=mint1,mint2,mint3 bun run burn:batch
```

Production versions require backend signature approval. Unsafe demo mode skips backend signatures when `unsafeDemo` is `true`.

## MXE Deployment (Arcium Only)

To use the Arcium backend, you must deploy an MXE on Solana devnet first:

1. Install Arcium CLI:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash
   arcup
   ```

2. Fund your devnet wallet:

   ```bash
   solana airdrop 5  # or use https://faucet.solana.com
   ```

3. Deploy MXE (costs ~3 SOL on devnet):

   ```bash
   arcium deploy \
     --cluster-offset 456 \
     --recovery-set-size 4 \
     --keypair-path ~/.config/solana/id.json \
     --rpc-url https://api.devnet.solana.com
   ```

4. Capture the printed MXE program ID and set:

   ```bash
   export ARCIUM_CLUSTER_OFFSET=456
   export ARCIUM_MXE_PROGRAM_ID=<MXE_PROGRAM_ID>
   ```

   Or add `mxeProgramId` to `scripts/config/mogate_giftcard.config.json` under `arcium`.

5. Verify:
   ```bash
   bun run step2:mint:arcium
   ```

This is a one-time deployment per cluster offset. The Encrypt backend does not require an MXE and is cheaper for testing.
