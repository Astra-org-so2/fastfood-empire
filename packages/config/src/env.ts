import fs from 'node:fs';
import path from 'node:path';

/** Loads `.env` if present. Node's own loader keeps parsing in one place. */
export function loadDotEnv(repoRoot: string): { loaded: string | null; error: string | null } {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return { loaded: null, error: null };
  try {
    // process.loadEnvFile does not overwrite already-set variables (Node >= 20.12).
    process.loadEnvFile(envPath);
    return { loaded: envPath, error: null };
  } catch (err) {
    return { loaded: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function envList(name: string): string[] {
  const raw = env(name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
