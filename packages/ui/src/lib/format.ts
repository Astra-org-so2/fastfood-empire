import type { ErrorCategory, QuotaType } from '@aido/types';

/**
 * Formatting helpers shared by every screen.
 *
 * The rule throughout: a value that is not known is rendered as "unknown" (with the
 * reason where there is one) and never as `0` or a plausible-looking default (§5, §21).
 */

export function formatNumber(value: number | null | undefined, options: { compact?: boolean; digits?: number } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (options.compact && Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: options.digits ?? (Number.isInteger(value) ? 0 : 2) }).format(value);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatCost(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return 'unknown cost';
  if (value === 0) return `$0.00 ${currency}`.replace(' USD', '');
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  if (Math.abs(value) < 0.01) return `${symbol}${value.toFixed(4)}`;
  return `${symbol}${value.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diff = Date.now() - then;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [1_000, 'second'],
    [60_000, 'minute'],
    [3_600_000, 'hour'],
    [86_400_000, 'day'],
  ];
  let label = `${Math.round(abs / 1_000)}s`;
  if (abs >= 86_400_000) label = `${Math.round(abs / 86_400_000)}d`;
  else if (abs >= 3_600_000) label = `${Math.round(abs / 3_600_000)}h`;
  else if (abs >= 60_000) label = `${Math.round(abs / 60_000)}m`;
  else label = `${Math.round(abs / 1_000)}s`;
  void units;
  return future ? `in ${label}` : `${label} ago`;
}

/** Countdown to a quota reset, or an explicit "unknown" when the provider has not told us. */
export function formatCountdown(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 'unknown';
  const diff = target - Date.now();
  if (diff <= 0) return 'now';
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(value === 0 || Math.abs(value) >= 0.1 ? 0 : 1)}%`;
}

const QUOTA_TYPE_LABELS: Record<QuotaType, string> = {
  free_renewable: 'FREE_RENEWABLE',
  free_trial: 'FREE_TRIAL',
  paid: 'PAID',
  unknown: 'UNKNOWN',
  user_hosted: 'USER_HOSTED',
};

export const quotaTypeLabel = (value: QuotaType | null | undefined): string => (value ? QUOTA_TYPE_LABELS[value] : 'UNKNOWN');

const ERROR_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  timeout: 'Timeout',
  rate_limit: 'Rate limited',
  quota_exhausted: 'Quota exhausted',
  authentication: 'Invalid credentials',
  invalid_request: 'Invalid request',
  context_length: 'Context too long',
  server_error: 'Provider error',
  model_unavailable: 'Model unavailable',
  network_error: 'Network failure',
  content_filter: 'Content filtered',
  cancelled: 'Cancelled',
  unknown: 'Unknown error',
};

export const errorCategoryLabel = (category: ErrorCategory | null | undefined): string =>
  category ? (ERROR_CATEGORY_LABELS[category] ?? category) : 'No error';

/** `provider/model` ids are long; keep the tail readable in tables. */
export function shortenModelId(modelId: string, max = 34): string {
  return modelId.length <= max ? modelId : `${modelId.slice(0, max - 1)}…`;
}

export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
