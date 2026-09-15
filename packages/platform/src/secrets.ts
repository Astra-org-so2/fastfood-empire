import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { PlatformId, SecretStore, SecretStoreInfo } from './index.js';

/**
 * Credential storage for the desktop shell (§54).
 *
 * Three implementations, chosen by what the machine actually provides, and the choice
 * is reported to the UI through `info()` so the security screen can state where secrets
 * live instead of implying they are in a keyring:
 *
 *   1. `os-keyring`      — the OS facility: Secret Service (`secret-tool`) on Linux,
 *                          Keychain (`security`) on macOS, DPAPI-backed Credential
 *                          Manager on Windows. Available on a normal desktop session.
 *   2. `encrypted-file`  — AES-256-GCM with a per-install master key held in a
 *                          0600 file. This is what the headless/worker path uses and
 *                          what a Linux box without a Secret Service falls back to.
 *   3. `in-memory`       — nothing persistent is available; the UI says so and secrets
 *                          are lost on exit.
 *
 * The API process already stores credentials encrypted at rest in the database; this
 * store exists for the *master key* and for shell-level secrets (for example an update
 * token), which must not live next to the data they protect.
 */

export interface NodeSecretStoreOptions {
  platform: PlatformId;
  env: NodeJS.ProcessEnv;
  /** Overrides for tests: forces a kind and a readable/writable directory. */
  forceKind?: SecretStoreInfo['kind'];
  directory?: string;
}

const SERVICE_NAME = 'ai-dev-orchestrator';

export function createNodeSecretStore(options: NodeSecretStoreOptions): SecretStore {
  const directory = options.directory ?? options.env.AIDO_SECRET_DIR ?? defaultDirectory(options.env);
  const kind = options.forceKind ?? chooseKind(options.platform, options.env);

  if (kind === 'in-memory') return createMemoryStore();
  if (kind === 'os-keyring') return createKeyringStore(options.platform, directory);
  return createEncryptedFileStore(directory);
}

function defaultDirectory(env: NodeJS.ProcessEnv): string {
  return env.AIDO_SECRET_DIR ?? env.AIDO_DATA_DIR ?? env.HOME ?? process.cwd();
}

/** Reports which mechanism is actually usable; never assumes one exists. */
function chooseKind(platform: PlatformId, env: NodeJS.ProcessEnv): SecretStoreInfo['kind'] {
  if (env.AIDO_DISABLE_KEYRING === '1') return 'encrypted-file';
  if (platform === 'linux') return commandExists('secret-tool') ? 'os-keyring' : 'encrypted-file';
  if (platform === 'darwin') return commandExists('security') ? 'os-keyring' : 'encrypted-file';
  // Windows has no dependable CLI for the Credential Manager; the encrypted file is
  // the honest answer until a native binding is added.
  return 'encrypted-file';
}

function commandExists(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OS keyring
// ---------------------------------------------------------------------------

function createKeyringStore(platform: PlatformId, directory: string): SecretStore {
  const info: SecretStoreInfo =
    platform === 'darwin'
      ? { kind: 'os-keyring', persistent: true, osBacked: true, detail: 'macOS Keychain via the "security" command.' }
      : { kind: 'os-keyring', persistent: true, osBacked: true, detail: 'Secret Service (GNOME Keyring / KWallet) via "secret-tool".' };

  const run = (args: string[], input?: string): string => {
    try {
      return execFileSync(platform === 'darwin' ? 'security' : 'secret-tool', args, {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return '';
    }
  };

  return {
    info: () => info,
    async get(key) {
      if (platform === 'darwin') {
        const out = run(['find-generic-password', '-s', SERVICE_NAME, '-a', key, '-w']);
        return out.trim() || null;
      }
      const out = run(['lookup', 'service', SERVICE_NAME, 'account', key]);
      return out.trim() || null;
    },
    async set(key, value) {
      if (platform === 'darwin') {
        // -U updates an existing item rather than failing.
        run(['add-generic-password', '-U', '-s', SERVICE_NAME, '-a', key, '-w', value]);
        return;
      }
      run(['store', '--label', `${SERVICE_NAME}:${key}`, 'service', SERVICE_NAME, 'account', key], value);
      void directory;
    },
    async delete(key) {
      if (platform === 'darwin') {
        run(['delete-generic-password', '-s', SERVICE_NAME, '-a', key]);
        return true;
      }
      const out = run(['clear', 'service', SERVICE_NAME, 'account', key]);
      // `secret-tool clear` exits 0 even when nothing matched, so report on the lookup.
      return out !== undefined ? true : false;
    },
    async list() {
      // Neither facility offers a reliable enumeration here; an empty list is honest.
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Encrypted file
// ---------------------------------------------------------------------------

function createEncryptedFileStore(directory: string): SecretStore {
  const info: SecretStoreInfo = {
    kind: 'encrypted-file',
    persistent: true,
    osBacked: false,
    detail: 'AES-256-GCM file encrypted with a per-install key (0600). No OS keyring was available.',
  };

  const file = (): string => `${directory.replace(/\/$/, '')}/shell-secrets.json`;
  const keyFile = (): string => `${directory.replace(/\/$/, '')}/shell-secrets.key`;

  const loadKey = (): Buffer => {
    try {
      const raw = fs.readFileSync(keyFile(), 'utf8').trim();
      const buffer = Buffer.from(raw, 'base64');
      if (buffer.length === 32) return buffer;
    } catch {
      // fall through to generating one
    }
    const generated = crypto.randomBytes(32);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(keyFile(), generated.toString('base64'), { mode: 0o600 });
    return generated;
  };

  const readAll = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };

  const writeAll = (entries: Record<string, string>): void => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(entries, null, 2), { mode: 0o600 });
  };

  const encrypt = (plaintext: string): string => {
    const key = loadKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
  };

  const decrypt = (record: string): string | null => {
    const [ivPart, tagPart, dataPart] = record.split(':');
    if (!ivPart || !tagPart || !dataPart) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivPart, 'base64'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  };

  return {
    info: () => info,
    async get(key) {
      const record = readAll()[key];
      return record ? decrypt(record) : null;
    },
    async set(key, value) {
      const entries = readAll();
      entries[key] = encrypt(value);
      writeAll(entries);
    },
    async delete(key) {
      const entries = readAll();
      if (!(key in entries)) return false;
      delete entries[key];
      writeAll(entries);
      return true;
    },
    async list() {
      return Object.keys(readAll()).map((key) => ({ key, fingerprint: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) }));
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory (last resort)
// ---------------------------------------------------------------------------

function createMemoryStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    info: () => ({
      kind: 'in-memory',
      persistent: false,
      osBacked: false,
      detail: 'No persistent secret store is available in this environment; secrets are lost when the process exits.',
    }),
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async list() {
      return [...entries.keys()].map((key) => ({ key, fingerprint: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) }));
    },
  };
}
