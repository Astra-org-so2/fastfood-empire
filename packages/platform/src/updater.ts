import type { PlatformId, UpdateCheckResult, UpdateManifest, Updater } from './index.js';

/**
 * Updates (§54).
 *
 * The Linux package is distributed as a `.deb` (and optionally an AppImage), so the
 * update path is deliberately simple and transparent:
 *
 *   - the app reads an update manifest (`update.json`) from a configured URL,
 *   - compares semantic versions,
 *   - and, when an automatic path is not available, tells the operator exactly which
 *     package to install — it never pretends an update was applied.
 *
 * Automatic installation is intentionally not implemented here: writing to `/usr` or
 * replacing a running AppImage requires privileges the app does not have and should not
 * silently take. The desktop shell surfaces "update available" plus the exact command
 * or download URL; if a package manager is present the operator can act on it.
 */
export interface NodeUpdaterOptions {
  platform: PlatformId;
  feedUrl: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export function createNodeUpdater(options: NodeUpdaterOptions): Updater {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    feedUrl: () => options.feedUrl,

    async check(currentVersion: string): Promise<UpdateCheckResult> {
      if (!options.feedUrl) {
        return {
          status: 'unsupported',
          currentVersion,
          instructions: updateInstructions(options.platform, null),
        };
      }

      try {
        const response = await fetchImpl(options.feedUrl, { headers: { accept: 'application/json' } });
        if (!response.ok) {
          return {
            status: 'check-failed',
            currentVersion,
            instructions: updateInstructions(options.platform, null),
            error: `Update feed responded with HTTP ${response.status}.`,
          };
        }
        const manifest = (await response.json()) as UpdateManifest;
        if (!manifest.version) {
          return {
            status: 'check-failed',
            currentVersion,
            instructions: updateInstructions(options.platform, null),
            error: 'Update manifest did not contain a version.',
          };
        }
        const available = compareVersions(manifest.version, currentVersion) > 0;
        return {
          status: available ? 'update-available' : 'up-to-date',
          currentVersion,
          latest: manifest,
          instructions: updateInstructions(options.platform, manifest),
        };
      } catch (err) {
        return {
          status: 'check-failed',
          currentVersion,
          instructions: updateInstructions(options.platform, null),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/** Compares dotted numeric versions; a prerelease suffix sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { numbers: number[]; prerelease: string | null } => {
    const [core, prerelease = null] = value.replace(/^v/, '').split('-', 2);
    return { numbers: (core ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const l = left.numbers[index] ?? 0;
    const r = right.numbers[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

/** Plain, actionable text: what to download and how to install it. */
export function updateInstructions(platform: PlatformId, manifest: UpdateManifest | null): string {
  if (!manifest) {
    return platform === 'linux'
      ? 'No update feed configured. Updates are installed by replacing the .deb package or AppImage with a newer build.'
      : 'Automatic updates are not implemented for this platform yet.';
  }
  const lines = [`Version ${manifest.version} is available.`, manifest.notes ? `Notes: ${manifest.notes}` : ''].filter(Boolean);
  const deb = manifest.artifacts.deb;
  const appImage = manifest.artifacts.AppImage;
  if (deb) lines.push(`Install with: sudo apt install --reinstall ${deb}`);
  if (appImage) lines.push(`Or replace the AppImage: download ${appImage} and make it executable (chmod +x).`);
  if (!deb && !appImage) lines.push('No package artefact is listed in the update manifest.');
  return lines.join('\n');
}
