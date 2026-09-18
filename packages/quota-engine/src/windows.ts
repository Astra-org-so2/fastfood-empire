import type { QuotaWindow, ResetStrategy } from '@aido/types';

/**
 * Daily reset engine (§9).
 *
 * Providers do NOT all reset at UTC midnight, and assuming they do produces a
 * quota model that is wrong for most of the day. This module derives window
 * boundaries from a declared strategy, with real timezone arithmetic (DST-aware)
 * rather than a fixed offset.
 *
 * Every result carries `estimated`, because a reset time derived from a schedule
 * is an estimate unless the provider reported it.
 */

export interface QuotaWindowRange {
  start: Date;
  end: Date;
  /** True when the boundary is derived from a schedule rather than reported by the API. */
  estimated: boolean;
  strategy: ResetStrategy;
  /**
   * Bucket granularity this range is stored under. Rolling windows are stored
   * hourly: a single "day" bucket whose start moves every second would never be
   * found again, so usage would silently disappear.
   */
  bucket: QuotaWindow;
  /** Present for rolling strategies: aggregate this many buckets backwards. */
  rolling?: { window: QuotaWindow; spanMs: number };
}

export interface WindowContext {
  now?: Date;
  resetStrategy: ResetStrategy;
  /** IANA timezone for `provider_timezone`, e.g. 'America/Los_Angeles'. */
  resetTimezone?: string | null;
  /** For `explicit_timestamp` / API-reported resets. */
  resetsAt?: string | Date | null;
  /** Rolling window length; defaults to 24h for `rolling_24h`. */
  rollingMs?: number;
}

export function computeWindow(context: WindowContext): QuotaWindowRange {
  const now = context.now ?? new Date();
  switch (context.resetStrategy) {
    case 'utc_midnight': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start, end: addDays(start, 1), estimated: true, strategy: context.resetStrategy, bucket: 'per_day' };
    }
    case 'provider_timezone': {
      const timezone = context.resetTimezone;
      if (!timezone) {
        // Declared but unspecified timezone: fall back to UTC and flag it loudly.
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        return { start, end: addDays(start, 1), estimated: true, strategy: 'utc_midnight', bucket: 'per_day' };
      }
      const start = startOfLocalDay(now, timezone);
      const end = nextLocalMidnight(start, timezone);
      return { start, end, estimated: true, strategy: context.resetStrategy, bucket: 'per_day' };
    }
    case 'rolling_24h': {
      const rollingMs = context.rollingMs ?? 24 * 60 * 60 * 1000;
      // The trailing window is represented as the *current* hour bucket plus a
      // rolling lookback: the bucket is stable and found again, while enforcement
      // and reporting aggregate the trailing span.
      const bucketStart = floorTo(now, 60 * 60 * 1000);
      return {
        start: bucketStart,
        end: addHours(bucketStart, 1),
        estimated: true,
        strategy: context.resetStrategy,
        bucket: 'per_hour',
        rolling: { window: 'per_hour', spanMs: rollingMs },
      };
    }
    case 'explicit_timestamp': {
      const resetsAt = context.resetsAt ? new Date(context.resetsAt) : null;
      if (!resetsAt || Number.isNaN(resetsAt.getTime())) {
        return {
          start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
          end: addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), 1),
          estimated: true,
          strategy: 'utc_midnight',
          bucket: 'per_day',
        };
      }
      const start = new Date(resetsAt);
      const end = addDays(resetsAt, 1);
      // If the stored timestamp is stale, roll it forward by whole days.
      while (end < now) {
        start.setUTCDate(start.getUTCDate() + 1);
        end.setUTCDate(end.getUTCDate() + 1);
      }
      return { start, end, estimated: false, strategy: context.resetStrategy, bucket: 'per_day' };
    }
    case 'api_reported': {
      const resetsAt = context.resetsAt ? new Date(context.resetsAt) : null;
      if (resetsAt && !Number.isNaN(resetsAt.getTime()) && resetsAt > now) {
        return {
          start: new Date(now.getTime() - (24 * 60 * 60 * 1000 - (resetsAt.getTime() - now.getTime()))),
          end: resetsAt,
          estimated: false,
          strategy: context.resetStrategy,
          bucket: 'per_day',
        };
      }
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start, end: addDays(start, 1), estimated: true, strategy: context.resetStrategy, bucket: 'per_day' };
    }
    case 'unknown':
    default: {
      // Unknown strategy: use a UTC day but mark it clearly as estimated so the UI
      // can say "resets at 00:00 UTC (estimated — provider does not document this)".
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start, end: addDays(start, 1), estimated: true, strategy: 'unknown', bucket: 'per_day' };
    }
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

/** Floors an instant to a multiple of `granularityMs` (UTC-aligned). */
export function floorTo(date: Date, granularityMs: number): Date {
  return new Date(Math.floor(date.getTime() / granularityMs) * granularityMs);
}

/** Floors an instant to the start of its minute. */
export function floorToMinute(date: Date): Date {
  return floorTo(date, 60_000);
}

/** Offset of a timezone at a given instant, in ms (positive = ahead of UTC). */
export function timezoneOffsetMs(timezone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(timezone: string, date: Date): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** Converts a wall-clock time in `timezone` to the corresponding UTC instant. */
export function zonedTimeToUtc(parts: LocalParts, timezone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // Two-pass refinement handles DST transitions: the first guess uses the offset at
  // the target's nominal time, the second corrects using the offset at that instant.
  let guess = target - timezoneOffsetMs(timezone, new Date(target));
  for (let i = 0; i < 3; i += 1) {
    const offset = timezoneOffsetMs(timezone, new Date(guess));
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Start of the current local day in the given timezone. */
export function startOfLocalDay(now: Date, timezone: string): Date {
  const parts = localParts(timezone, now);
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timezone);
}

/** Next local midnight strictly after the start of the local day containing `start`. */
export function nextLocalMidnight(start: Date, timezone: string): Date {
  const parts = localParts(timezone, start);
  // Increment the calendar day (handles month/year rollover via Date.UTC normalisation).
  const nextDayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return zonedTimeToUtc(
    { year: nextDayUtc.getUTCFullYear(), month: nextDayUtc.getUTCMonth() + 1, day: nextDayUtc.getUTCDate(), hour: 0, minute: 0, second: 0 },
    timezone,
  );
}

/** Human label for the reset boundary, used in the quota dashboard. */
export function describeReset(range: QuotaWindowRange, timezone?: string | null): string {
  if (range.strategy === 'rolling_24h') return 'rolling 24h window';
  const tzLabel = range.strategy === 'utc_midnight' ? 'UTC' : (timezone ?? 'provider local time');
  const time = `${String(range.end.getUTCHours()).padStart(2, '0')}:${String(range.end.getUTCMinutes()).padStart(2, '0')}`;
  return `${time} ${tzLabel}${range.estimated ? ' (estimated)' : ''}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
