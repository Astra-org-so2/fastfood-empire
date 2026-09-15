import os from 'node:os';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

/** In-process performance counters + timers used by the metrics service. */

export interface CounterSnapshot {
  name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Fixed-window histogram: keeps raw samples for the last N observations so
 * percentiles are real rather than estimated. Memory is bounded, which matters
 * because this runs inside a long-lived server.
 */
export class Histogram {
  private readonly samples: number[] = [];
  private count = 0;
  private sum = 0;
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = Number.NEGATIVE_INFINITY;

  constructor(
    readonly name: string,
    private readonly capacity = 2048,
  ) {}

  observe(value: number): void {
    if (!Number.isFinite(value)) return;
    this.count += 1;
    this.sum += value;
    if (value < this.minValue) this.minValue = value;
    if (value > this.maxValue) this.maxValue = value;
    this.samples.push(value);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  snapshot(): CounterSnapshot {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      name: this.name,
      count: this.count,
      sum: this.sum,
      min: this.count ? this.minValue : 0,
      max: this.count ? this.maxValue : 0,
      last: sorted.length ? sorted[sorted.length - 1]! : 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.count = 0;
    this.sum = 0;
    this.minValue = Number.POSITIVE_INFINITY;
    this.maxValue = Number.NEGATIVE_INFINITY;
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export async function timeIt<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

/** Exponential weighted moving average — used for latency/success learnings. */
export function ewma(previous: number | null, sample: number, alpha = 0.25): number {
  if (previous === null || !Number.isFinite(previous)) return sample;
  return previous * (1 - alpha) + sample * alpha;
}

export interface DiskUsage {
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  usedPercent: number | null;
}

/**
 * Node has no statfs. `fs.statfs` exists on Node >= 18.15 — use it, and report
 * null rather than a made-up number when unavailable (§46).
 */
export function diskUsage(targetPath: string): DiskUsage {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string, o?: { bigint?: boolean }) => { bsize: number; blocks: number; bfree: number; bavail: number } }).statfsSync;
    if (typeof statfs === 'function') {
      const s = statfs(targetPath);
      const total = s.bsize * s.blocks;
      const free = s.bsize * s.bavail;
      return {
        path: targetPath,
        totalBytes: total,
        freeBytes: free,
        usedPercent: total > 0 ? ((total - free) / total) * 100 : null,
      };
    }
  } catch {
    /* fallthrough to nulls */
  }
  return { path: targetPath, totalBytes: null, freeBytes: null, usedPercent: null };
}

export interface CpuTimesSample {
  at: number;
  idle: number;
  total: number;
}

let lastCpu: CpuTimesSample | null = null;

/** CPU% derived from successive os.cpus() samples (Node gives cumulative ticks). */
export function cpuPercent(): number | null {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  const sample: CpuTimesSample = { at: Date.now(), idle, total };
  const previous = lastCpu;
  lastCpu = sample;
  if (!previous) return null;
  const idleDelta = sample.idle - previous.idle;
  const totalDelta = sample.total - previous.total;
  if (totalDelta <= 0) return null;
  const busy = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(1, busy)) * 100;
}

export function memorySnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    memoryUsedBytes: used,
    memoryTotalBytes: total,
    memoryPercent: total > 0 ? (used / total) * 100 : 0,
    loadAverage: os.loadavg(),
    cpuCount: os.cpus().length,
    uptimeSeconds: os.uptime(),
    processMemoryBytes: process.memoryUsage().rss,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    nodeVersion: process.version,
  };
}
