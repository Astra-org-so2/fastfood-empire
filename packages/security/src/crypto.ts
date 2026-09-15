import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Credential encryption at rest (§30).
 *
 * AES-256-GCM with a per-record random IV. The record is bound with additional
 * authenticated data (AAD) to its logical slot, so a ciphertext cannot be
 * silently moved between providers or credential fields (a real attack class in
 * multi-tenant key stores). The master key is 32 random bytes, sourced from
 * AIDO_MASTER_KEY or generated once into a 0600 file.
 */

export interface EncryptedRecord {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
  /** Fingerprint of the plaintext (non-reversible) for change detection. */
  fp: string;
}

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

export function loadMasterKey(options: { keyFile: string; envValue?: string }): { key: Buffer; source: 'env' | 'file'; created: boolean } {
  const envValue = options.envValue?.trim();
  if (envValue) {
    return { key: deriveKeyFromSecret(envValue), source: 'env', created: false };
  }
  if (fs.existsSync(options.keyFile)) {
    const raw = fs.readFileSync(options.keyFile);
    const parsed = parseKeyFile(raw);
    if (parsed) return { key: parsed, source: 'file', created: false };
    throw new VaultKeyError(
      `Master key file ${options.keyFile} exists but is not a valid 32-byte key. ` +
        'Delete it to regenerate (this destroys access to stored credentials) or set AIDO_MASTER_KEY.',
    );
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(options.keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(options.keyFile, key.toString('base64'), { mode: 0o600 });
  return { key, source: 'file', created: true };
}

function parseKeyFile(raw: Buffer): Buffer | null {
  const text = raw.toString('utf8').trim();
  if (/^[A-Za-z0-9+/=]{43,44}$/.test(text)) {
    const buf = Buffer.from(text, 'base64');
    if (buf.length === 32) return buf;
  }
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (raw.length === 32) return raw;
  return null;
}

/** Accepts either a base64/hex 32-byte key or a passphrase (scrypt-derived). */
function deriveKeyFromSecret(secret: string): Buffer {
  try {
    if (/^[A-Za-z0-9+/=]{43,44}$/.test(secret)) {
      const buf = Buffer.from(secret, 'base64');
      if (buf.length === 32) return buf;
    }
    if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  } catch {
    /* fall through to KDF */
  }
  // Deterministic derivation so the same passphrase always unlocks the same data.
  return crypto.scryptSync(secret, 'aido.credential.vault.v1', 32, { N: 16384, r: 8, p: 1 });
}

export function fingerprint(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 16);
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): EncryptedRecord {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    fp: fingerprint(plaintext),
  };
}

export class DecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptError';
  }
}

export function decryptSecret(record: EncryptedRecord, key: Buffer, aad: string): string {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    throw new DecryptError(
      'Stored credential could not be decrypted. The master key changed, or the record was tampered with. ' +
        'Re-enter the provider API key in Settings → Providers.',
      { cause: err },
    );
  }
}

export function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return r.v === 1 && r.alg === 'aes-256-gcm' && typeof r.iv === 'string' && typeof r.tag === 'string' && typeof r.ciphertext === 'string';
}

/** Constant-time comparison for tokens/passwords used in local auth. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // still do work to avoid trivial length oracle
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
