/**
 * Secret redaction (§30). Every log line and every error surfaced through the API
 * passes through here. Patterns are deliberately broad: a leaked key in a log
 * costs the user real money and real quota.
 */

const SECRET_KEY_NAMES =
  /^(api[-_]?key|apikey|authorization|auth|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|pwd|bearer|session[-_]?id|private[-_]?key|account[-_]?id|credential|credentials|x-api-key)$/i;

/** Well-known credential shapes. Keep in sync with PROVIDER docs when adding providers. */
const SECRET_VALUE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openai_style_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'groq_key', re: /\bgsk_[A-Za-z0-9]{16,}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'huggingface_token', re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: 'openrouter_key', re: /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g },
  { name: 'nvidia_key', re: /\bnvapi-[A-Za-z0-9_-]{16,}\b/g },
  // NOTE: deliberately no "any 40-char token" pattern. Git object ids are 40
  // hex characters; a greedy generic rule would redact commit SHAs out of every
  // diff and log line. Only prefix-anchored, provably-credential shapes go here.
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_oauth', re: /\bya29\.[0-9A-Za-z_-]{20,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'postgres_url', re: /postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi },
  { name: 'basic_auth_header', re: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{8,}/gi },
  { name: 'bearer_header', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
];

const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  let out = input;
  for (const { re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  // query-string style secrets: ?key=... &api_key=...
  out = out.replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, `$1${REDACTED}`);
  return out;
}

/** Recursively redacts objects. Depth-limited to survive cyclic-ish payloads. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_NAMES.test(key) ? REDACTED : redactValue(val, depth + 1);
  }
  return out;
}

/**
 * Produces a display-safe fingerprint of a secret: enough to recognise which key
 * is configured, never enough to use it.
 */
export function fingerprintSecret(secret: string): string {
  if (!secret) return '';
  const trimmed = secret.trim();
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  return `${head}…${tail} (${trimmed.length} chars)`;
}

export function isSecretLike(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(value);
  });
}

/**
 * Scrubs anything that looks like a credential out of untrusted content before
 * it is sent to a model — a repository can legitimately contain a live key in a
 * committed file, and we must not forward it to a third-party inference provider.
 */
export function scrubSecretsFromPrompt(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const { re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  return { text: out, redactions };
}
