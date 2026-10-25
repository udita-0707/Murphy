import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parses MURPHY_ENCRYPTION_KEY: base64 of exactly 32 bytes (`openssl rand -base64 32`). */
export function parseEncryptionKey(base64: string | undefined): Buffer {
  if (!base64) {
    throw new Error(
      "MURPHY_ENCRYPTION_KEY is not set (generate one with: openssl rand -base64 32)",
    );
  }
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error(`MURPHY_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** Encrypts with AES-256-GCM. Output layout: iv (12) || auth tag (16) || ciphertext. */
export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts the output of encryptSecret. Throws if the data was tampered with. */
export function decryptSecret(data: Buffer, key: Buffer): string {
  if (data.length < IV_BYTES + TAG_BYTES) {
    throw new Error("encrypted secret is too short");
  }
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
