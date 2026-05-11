declare module "@encrypt.xyz/pre-alpha-solana-client/grpc" {
  export const Chain: {
    readonly Solana: 0;
  };

  export const DEVNET_PRE_ALPHA_GRPC_URL: string;

  export function encodeReadCiphertextMessage(
    chain: number,
    ciphertextIdentifier: Uint8Array,
    reencryptionKey: Uint8Array,
    epoch: bigint,
  ): Buffer;

  export function createEncryptClient(grpcUrl?: string): {
    createInput(params: {
      chain: number;
      inputs: Array<{ ciphertextBytes: Uint8Array; fheType: number }>;
      proof?: Buffer;
      authorized: Buffer;
      networkEncryptionPublicKey: Buffer;
    }): Promise<{ ciphertextIdentifiers: Uint8Array[] }>;
    readCiphertext(params: {
      message: Buffer;
      signature: Buffer;
      signer: Buffer;
    }): Promise<{ value: Buffer; fheType: number; digest: Buffer }>;
    close(): void;
  };
}
