import type { SystemMetrics } from '@aido/types';
import { cpuPercent, diskUsage, memorySnapshot } from './metrics-primitives.js';

export interface SystemMetricsCollectorOptions {
  diskPath: string;
  /** Interval between background samples in ms. 0 disables the loop. */
  intervalMs?: number;
  onSample?: (sample: SystemMetrics) => void;
}

export function collectSystemMetrics(diskPath: string): SystemMetrics {
  const mem = memorySnapshot();
  const disk = diskUsage(diskPath);
  return {
    cpuPercent: cpuPercent(),
    cpuCount: mem.cpuCount,
    memoryUsedBytes: mem.memoryUsedBytes,
    memoryTotalBytes: mem.memoryTotalBytes,
    memoryPercent: mem.memoryPercent,
    loadAverage: mem.loadAverage,
    uptimeSeconds: mem.uptimeSeconds,
    disk,
    processMemoryBytes: mem.processMemoryBytes,
    platform: mem.platform,
    nodeVersion: mem.nodeVersion,
  };
}

/**
 * Periodically samples system metrics. The first CPU reading is always null
 * because a delta requires two samples — the caller gets an honest `null`
 * rather than a fabricated 0%.
 */
export class SystemMetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private last: SystemMetrics | null = null;

  constructor(private readonly options: SystemMetricsCollectorOptions) {}

  start(): void {
    if (this.timer || !this.options.intervalMs) return;
    const tick = () => {
      const sample = collectSystemMetrics(this.options.diskPath);
      this.last = sample;
      this.options.onSample?.(sample);
    };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latest(): SystemMetrics {
    return this.last ?? collectSystemMetrics(this.options.diskPath);
  }
}
