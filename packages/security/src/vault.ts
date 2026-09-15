/**
 * Credential vault: encrypts provider API keys at rest and hands them out only
 * through an explicit `resolve` call, so plaintext keys are never held in a
 * long-lived structure that could be serialised into a log or an API response.
 *
 * The `CredentialStore` interface is what the rest of the app depends on; the
 * SQLite-backed implementation lives in @aido/storage and is injected at startup
 * (dependency inversion — packages/security does not know about SQLite).
 */
import { decryptSecret, encryptSecret, fingerprint, isEncryptedRecord, type EncryptedRecord } from './crypto.js';

export interface CredentialRecord {
  providerId: string;
  field: string;
  encrypted: EncryptedRecord;
  /** Human-recognisable, non-reversible hint e.g. "gsk_…4f2a (56 chars)". */
  displayHint: string;
  createdAt: string;
  updatedAt: string;
  /** Last time the credential was used to make a successful request. */
  lastUsedAt: string | null;
  lastValidatedAt: string | null;
  validationState: 'valid' | 'invalid' | 'unverified' | 'unconfigured';
  validationDetail: string | null;
}

export interface CredentialStore {
  list(providerId?: string): CredentialRecord[];
  get(providerId: string, field: string): CredentialRecord | null;
  upsert(record: CredentialRecord): void;
  delete(providerId: string, field: string): number;
  touch(providerId: string, field: string, patch: Partial<Pick<CredentialRecord, 'lastUsedAt' | 'lastValidatedAt' | 'validationState' | 'validationDetail'>>): void;
}

export interface VaultOptions {
  store: CredentialStore;
  key: Buffer;
  /** Non-secret fallback values (env vars), consulted when the store has nothing. */
  envFallback?: (providerId: string, field: string) => string | undefined;
  /** Master-key file path, surfaced for diagnostics only. */
  keyFile?: string;
}

/**
 * Bound AAD: identifies the logical slot a ciphertext belongs to. Prevents a
 * valid ciphertext from being replayed into a different provider's slot.
 */
function aadFor(providerId: string, field: string): string {
  return `aido:credential:v1:${providerId}:${field}`;
}

export class CredentialVault {
  constructor(private readonly options: VaultOptions) {}

  /** Stores (or replaces) a credential. Plaintext is never returned or logged. */
  set(providerId: string, field: string, plaintext: string): CredentialRecord {
    const value = plaintext.trim();
    if (!value) throw new Error(`Refusing to store an empty credential for ${providerId}.${field}`);
    const now = new Date().toISOString();
    const existing = this.options.store.get(providerId, field);
    const record: CredentialRecord = {
      providerId,
      field,
      encrypted: encryptSecret(value, this.options.key, aadFor(providerId, field)),
      displayHint: `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      lastValidatedAt: null,
      validationState: 'unverified',
      validationDetail: existing && existing.encrypted.fp === fingerprint(value) ? existing.validationDetail : null,
    };
    this.options.store.upsert(record);
    return record;
  }

  /**
   * Resolves a credential for use in an outbound request. Callers must not log
   * the return value; the request layer redacts headers as a second line of defence.
   */
  resolve(providerId: string, field = 'apiKey'): { value: string; source: 'vault' | 'environment' } | null {
    const record = this.options.store.get(providerId, field);
    if (record) {
      const value = decryptSecret(record.encrypted, this.options.key, aadFor(providerId, field));
      this.options.store.touch(providerId, field, { lastUsedAt: new Date().toISOString() });
      return { value, source: 'vault' };
    }
    const fromEnv = this.options.envFallback?.(providerId, field);
    if (fromEnv) return { value: fromEnv, source: 'environment' };
    return null;
  }

  /** Non-secret metadata for the UI. Never includes the secret itself. */
  describe(providerId: string, field = 'apiKey'): Omit<CredentialRecord, 'encrypted'> | null {
    const record = this.options.store.get(providerId, field);
    if (!record) {
      const fromEnv = this.options.envFallback?.(providerId, field);
      if (fromEnv) {
        return {
          providerId,
          field,
          displayHint: `from environment (${fromEnv.slice(0, 4)}…${fromEnv.slice(-4)}, ${fromEnv.length} chars)`,
          createdAt: '',
          updatedAt: '',
          lastUsedAt: null,
          lastValidatedAt: null,
          validationState: 'unverified',
          validationDetail: 'Value provided by an environment variable, not stored in the vault.',
        };
      }
      return null;
    }
    const { encrypted: _encrypted, ...rest } = record;
    return rest;
  }

  listForProvider(providerId: string): Omit<CredentialRecord, 'encrypted'>[] {
    return this.options.store.list(providerId).map(({ encrypted: _e, ...rest }) => rest);
  }

  delete(providerId: string, field = 'apiKey'): boolean {
    return this.options.store.delete(providerId, field) > 0;
  }

  markValidated(providerId: string, field: string, state: 'valid' | 'invalid', detail: string | null): void {
    this.options.store.touch(providerId, field, {
      lastValidatedAt: new Date().toISOString(),
      validationState: state,
      validationDetail: detail,
    });
  }

  /** True when every required field for the provider definition is present. */
  hasAllFields(providerId: string, fields: { key: string; required: boolean }[]): { complete: boolean; missing: string[] } {
    const missing = fields.filter((f) => f.required && this.resolve(providerId, f.key) === null).map((f) => f.key);
    return { complete: missing.length === 0, missing };
  }
}

/** In-memory store used by tests and by the `--ephemeral` CLI mode. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly records = new Map<string, CredentialRecord>();
  private key(providerId: string, field: string) {
    return `${providerId}::${field}`;
  }
  list(providerId?: string): CredentialRecord[] {
    const all = [...this.records.values()];
    return providerId ? all.filter((r) => r.providerId === providerId) : all;
  }
  get(providerId: string, field: string): CredentialRecord | null {
    return this.records.get(this.key(providerId, field)) ?? null;
  }
  upsert(record: CredentialRecord): void {
    this.records.set(this.key(record.providerId, record.field), record);
  }
  delete(providerId: string, field: string): number {
    return this.records.delete(this.key(providerId, field)) ? 1 : 0;
  }
  touch(providerId: string, field: string, patch: Partial< CredentialRecord>): void {
    const existing = this.get(providerId, field);
    if (!existing) return;
    this.upsert({ ...existing, ...patch });
  }
}

export { isEncryptedRecord };
export type { EncryptedRecord };
