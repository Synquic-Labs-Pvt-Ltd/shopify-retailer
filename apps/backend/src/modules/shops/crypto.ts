import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// TOKEN_ENC_KEY is 32 bytes as 64 hex characters or standard base64 (see core/env.ts).
export function parseEncKey(value: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('TOKEN_ENC_KEY must decode to 32 bytes');
  return key;
}

export interface SecretBox {
  // Returns "base64(iv):base64(authTag):base64(cipherText)" (SPEC 14.1).
  encrypt(plainText: string): string;
  // Throws when the blob is malformed, was tampered with, or was sealed with another key.
  decrypt(blob: string): string;
}

export function createSecretBox(encKey: string): SecretBox {
  const key = parseEncKey(encKey);

  return {
    encrypt(plainText) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), cipherText].map((part) => part.toString('base64')).join(':');
    },

    decrypt(blob) {
      const parts = blob.split(':');
      if (parts.length !== 3) throw new Error('Malformed encrypted value');
      const [iv, tag, cipherText] = parts.map((part) => Buffer.from(part, 'base64'));
      if (iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES || cipherText === undefined) {
        throw new Error('Malformed encrypted value');
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    },
  };
}
