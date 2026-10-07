import * as Crypto from 'expo-crypto';

// PKCE S256 (SPEC 8.3 step 2). The verifier is 32 random bytes as 43 base64url characters; the challenge is the
// base64url SHA-256 of the verifier (also 43 characters), matching pkceVerifierSchema and pkceChallengeSchema.

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const chunk = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64URL.charAt((chunk >> 18) & 63) + BASE64URL.charAt((chunk >> 12) & 63);
    if (i + 1 < bytes.length) out += BASE64URL.charAt((chunk >> 6) & 63);
    if (i + 2 < bytes.length) out += BASE64URL.charAt(chunk & 63);
  }
  return out;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = toBase64Url(Crypto.getRandomBytes(32));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}
