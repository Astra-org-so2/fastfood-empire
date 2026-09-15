#!/usr/bin/env node
/**
 * Builds the Debian package for the Linux target (§54).
 *
 * The package installs the product into `/opt/ai-dev-orchestrator` and exposes it as a
 * normal Linux application:
 *
 *   - `aido`          start the API + built UI (the same server the desktop shell embeds)
 *   - `aido worker`   run background agents with no window, for systemd
 *   - `aido open`     start it if needed and open the UI
 *   - `aido desktop`  launch the Electron window, when that shell is part of the build
 *   - a desktop entry, an icon, and a systemd *user* unit for the background worker
 *
 * It deliberately does not depend on Electron: the API, worker and web bundle are plain
 * Node, so a `.deb` can be produced on any machine that has `dpkg-deb`. When the Electron
 * runtime *is* available (`apps/desktop/packaging/node_modules/electron`), the same
 * package additionally carries the native window shell and `aido desktop` works. That is
 * reported at the end of the build either way, so a package without the window shell can
 * never be mistaken for one with it.
 *
 * Usage:
 *   node scripts/build-deb.mjs [--arch=amd64] [--version=0.1.0] [--out=dist/installers]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = arg('version', packageJson.version);
const arch = arg('arch', process.arch === 'arm64' ? 'arm64' : 'amd64');
const outDir = path.resolve(root, arg('out', path.join('dist', 'installers')));
const appDirName = 'ai-dev-orchestrator';
const installRoot = `/opt/${appDirName}`;
const staging = path.join(outDir, '.staging', `${appDirName}_${version}_${arch}`);
const debPath = path.join(outDir, `${appDirName}_${version}_${arch}.deb`);

const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ prerequisites */

const required = [
  ['api bundle', path.join(root, 'dist', 'api', 'index.mjs')],
  ['worker bundle', path.join(root, 'dist', 'worker', 'index.mjs')],
  ['web bundle', path.join(root, 'dist', 'web', 'index.html')],
];
const missing = required.filter(([, file]) => !fs.existsSync(file));
if (missing.length) {
  fail(`${missing.map(([name]) => name).join(', ')} missing. Run \`npm run build\` first.`);
}
const dpkg = spawnSync('dpkg-deb', ['--version'], { stdio: 'ignore' });
if (dpkg.status !== 0) fail('dpkg-deb is required to build the package (apt install dpkg).');

const electronDist = path.join(root, 'apps', 'desktop', 'packaging', 'node_modules', 'electron', 'dist');
const hasElectron = fs.existsSync(path.join(electronDist, 'electron'));
const hasDesktopBundle = fs.existsSync(path.join(root, 'dist', 'desktop', 'main.cjs'));

/* ------------------------------------------------------------------ staging the tree */

fs.rmSync(staging, { recursive: true, force: true });
const write = (relative, contents, mode) => {
  const target = path.join(staging, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, mode ? { mode } : undefined);
};
const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};

// The application, laid out exactly as the source tree expects: config/providers is
// resolved relative to the bundle, so a copied tree behaves like a checkout.
fs.mkdirSync(path.join(staging, installRoot), { recursive: true });
for (const part of ['api', 'worker', 'web']) {
  copyTree(path.join(root, 'dist', part), path.join(staging, installRoot, 'dist', part));
}
copyTree(path.join(root, 'config'), path.join(staging, installRoot, 'config'));
for (const file of ['package.json', 'README.md', 'ARCHITECTURE.md', 'PROVIDERS.md', 'AGENTS.md', 'SECURITY.md', 'DEVELOPMENT.md', 'API.md']) {
  const source = path.join(root, file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staging, installRoot, file));
}
if (hasDesktopBundle) {
  copyTree(path.join(root, 'dist', 'desktop'), path.join(staging, installRoot, 'dist', 'desktop'));
}
if (hasElectron) {
  // Electron is a runtime dependency of the window shell, not of the server; it is only
  // copied when it is genuinely present, so `aido desktop` never points at nothing.
  copyTree(electronDist, path.join(staging, installRoot, 'electron'));
}

write(
  `usr/bin/aido`,
  `#!/bin/sh
# AI Dev Orchestrator — Linux launcher (§54).
#
# One product, two shells: this script starts the same server and the same web bundle the
# desktop window embeds. It never reaches into a checkout, so a package install and a
# source install behave identically.
set -eu

# AIDO_APP_DIR makes the tree relocatable: it is what the packaging test uses to run the
# launcher from an extracted package without installing it, and it keeps the script usable
# for a source build or an AppImage-style unpack.
APP_DIR="\${AIDO_APP_DIR:-${installRoot}}"

# Node 22.5+ is required (the storage layer uses node:sqlite).
NODE_BIN="\${AIDO_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "aido: node (>= 22.5) is required but was not found in PATH." >&2
  echo "aido: install it from https://nodejs.org or your distribution, or set AIDO_NODE." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "aido: node >= 22.5 is required (found $("$NODE_BIN" -v))." >&2
  exit 1
fi

# Per-user state. The packaged tree under /opt is read-only for normal users.
: "\${AIDO_DATA_DIR:=$HOME/.local/share/aido}"
: "\${AIDO_WORKSPACE_ROOT:=$HOME/aido}"
export AIDO_DATA_DIR AIDO_WORKSPACE_ROOT

# The server creates these too, but the launcher writes its log there before the
# server exists, and a first run should not fail on a missing directory.
mkdir -p "$AIDO_DATA_DIR" "$AIDO_WORKSPACE_ROOT"

usage() {
  cat <<'USAGE'
AI Dev Orchestrator

  aido [serve]        start the API and the web UI in the foreground
  aido open           start it in the background and open the UI
  aido worker [args]  run background agents (no HTTP server)
  aido desktop        launch the Electron window (if this package includes it)
  aido paths          print the directories this installation uses
  aido version        print the installed version

Environment:
  AIDO_DATA_DIR          storage root                 ($AIDO_DATA_DIR)
  AIDO_WORKSPACE_ROOT    where projects are created   ($AIDO_WORKSPACE_ROOT)
  AIDO_API_PORT          API port (default 8787)
  AIDO_LOG_LEVEL         trace|debug|info|warn|error
  AIDO_EXECUTION_MODE    auto|supervised|manual
USAGE
}

command="\${1:-serve}"
case "$command" in
  serve)
    shift || true
    exec "$NODE_BIN" "$APP_DIR/dist/api/index.mjs" "$@"
    ;;
  worker)
    shift || true
    exec "$NODE_BIN" "$APP_DIR/dist/worker/index.mjs" "$@"
    ;;
  open)
    port="\${AIDO_API_PORT:-8787}"
    url="http://127.0.0.1:\${port}/"
    wait_for_server() {
      PORT="$port" "$NODE_BIN" -e '
        const deadline = Date.now() + 20000;
        const tick = async () => {
          try { await fetch("http://127.0.0.1:" + process.env.PORT + "/api/ping"); process.exit(0); } catch {}
          if (Date.now() > deadline) process.exit(1);
          setTimeout(tick, 250);
        };
        tick();
      ' >/dev/null 2>&1
    }
    if ! wait_for_server; then
      echo "aido: starting the server on port $port…"
      "$NODE_BIN" "$APP_DIR/dist/api/index.mjs" >"\${AIDO_DATA_DIR}/server.log" 2>&1 &
      if ! wait_for_server; then
        echo "aido: the server did not become ready on port $port." >&2
        echo "aido: see \${AIDO_DATA_DIR}/server.log" >&2
        exit 1
      fi
    fi
    if command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1; then
      echo "aido: opened $url"
    else
      echo "aido: UI is running at $url"
    fi
    ;;
  desktop)
    if [ -x "$APP_DIR/electron/electron" ]; then
      exec "$APP_DIR/electron/electron" "$APP_DIR/desktop-launcher"
    fi
    if [ -x "$APP_DIR/electron/electron" ] || [ -d "$APP_DIR/electron" ]; then
      echo "aido: the packaged Electron runtime is incomplete." >&2
      exit 1
    fi
    echo "aido: this package was built without the desktop window shell." >&2
    echo "aido: rebuild with the Electron toolchain (see docs/DESKTOP.md), or use 'aido open'." >&2
    exit 1
    ;;
  paths)
    echo "install:   $APP_DIR"
    echo "data:      $AIDO_DATA_DIR"
    echo "workspaces:$AIDO_WORKSPACE_ROOT"
    ;;
  version)
    echo "ai-dev-orchestrator ${version}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "aido: unknown command '$command'" >&2
    usage >&2
    exit 2
    ;;
esac
`,
  0o755,
);

if (hasDesktopBundle) {
  // Electron needs a package.json pointing at the main script; keeping it inside the
  // package avoids writing into a checkout at runtime.
  write(
    `desktop-launcher/package.json`,
    `${JSON.stringify({ name: 'ai-dev-orchestrator-desktop', version, private: true, main: path.join(installRoot, 'dist', 'desktop', 'main.cjs') }, null, 2)}\n`,
  );
}

write(
  `usr/lib/systemd/user/${appDirName}-worker.service`,
  `[Unit]
Description=AI Dev Orchestrator background agents
Documentation=file:${installRoot}/README.md
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/aido worker
Restart=on-failure
RestartSec=5
# The worker writes only inside the user's state and workspace directories.
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
`,
);

write(
  `usr/share/applications/${appDirName}.desktop`,
  `[Desktop Entry]
Type=Application
Name=AI Dev Orchestrator
GenericName=AI engineering team
Comment=Multi-provider AI engineering team orchestration with quota awareness
Exec=/usr/bin/aido open
Icon=${appDirName}
Terminal=false
Categories=Development;Utility;
Keywords=ai;agents;llm;development;
StartupWMClass=ai-dev-orchestrator
`,
);

// Icon: a plain scalable mark. Drawn rather than shipped as a bitmap so it stays crisp
// on every desktop scale factor, and so no binary asset has to be vendored.
write(
  `usr/share/icons/hicolor/scalable/apps/${appDirName}.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="AI Dev Orchestrator">
  <rect width="256" height="256" rx="48" fill="#0b0f19"/>
  <g fill="none" stroke="#e2e8f0" stroke-width="14" stroke-linecap="round">
    <path d="M74 176V80l54 66 54-66v96"/>
  </g>
  <circle cx="74" cy="80" r="15" fill="#38bdf8"/>
  <circle cx="128" cy="146" r="15" fill="#38bdf8"/>
  <circle cx="182" cy="80" r="15" fill="#38bdf8"/>
</svg>
`,
);

/* ------------------------------------------------------------------ debian control */

const installedBytes = Number(
  spawnSync('du', ['-sb', staging], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0] ?? '0',
);
const installedKb = Math.max(1, Math.ceil(installedBytes / 1024));

const description = [
  'Multi-provider AI engineering team orchestration.',
  ' Runs a team of specialised agents across multiple LLM providers, tracks',
  ' renewable free quotas so exhausted providers are never called, routes each',
  ' task to the best available model, and drives a real Git repository through',
  ' plan, implementation, test and review stages.',
  ' .',
  ' Installs the API, the background worker and the web UI, plus a systemd user',
  ' unit for unattended agent work. When built with the Electron toolchain the',
  ' package also contains the native desktop window (run `aido desktop`).',
].join('\n');

write(
  `DEBIAN/control`,
  `Package: ${appDirName}
Version: ${version}
Section: devel
Priority: optional
Architecture: ${arch}
Depends: nodejs (>= 22.5), git
Recommends: libnotify-bin, xdg-utils
Maintainer: AI Dev Orchestrator contributors <maintainers@aido.local>
Installed-Size: ${installedKb}
Homepage: https://github.com/Astra-org-so2/fastfood-empire
Description: ${description}
`,
);

write(
  `DEBIAN/postinst`,
  `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
cat <<'MESSAGE'

AI Dev Orchestrator is installed.

  aido            start the API and the web UI
  aido open       start it and open the UI in your browser

To run background agents automatically (they survive closing the UI):

  systemctl --user enable --now ${appDirName}-worker.service
  journalctl --user -u ${appDirName}-worker.service -f

Untrusted code runs sandboxed, but agents still write into the workspace directory
(\${AIDO_WORKSPACE_ROOT:-$HOME/aido}) and can run project test commands. Read
${installRoot}/SECURITY.md before pointing it at a repository you care about.

Upgrades: install a newer .deb over this one (apt install ./<newer>.deb); the data
directory is left untouched.
MESSAGE
`,
  0o755,
);

write(
  `DEBIAN/prerm`,
  `#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop ${appDirName}-worker.service 2>/dev/null || true
  fi
fi
`,
  0o755,
);

/* ------------------------------------------------------------------ build + verify */

fs.mkdirSync(outDir, { recursive: true });
const build = spawnSync('dpkg-deb', ['--build', '--root-owner-group', staging, debPath], { stdio: 'inherit' });
if (build.status !== 0) fail('dpkg-deb failed to build the package.');
fs.rmSync(path.join(outDir, '.staging'), { recursive: true, force: true });

const sizeMb = (fs.statSync(debPath).size / (1024 * 1024)).toFixed(1);
log(`\n${path.relative(root, debPath)}  (${sizeMb} MB, ${installedKb} KB installed)`);
log(
  hasElectron && hasDesktopBundle
    ? 'Includes the native desktop window shell: `aido desktop`.'
    : 'Built without the desktop window shell (Electron runtime absent); `aido serve`, `aido worker` and `aido open` work, and `aido desktop` explains how to rebuild with it.',
);
log('\nInspect with:  dpkg-deb -I ' + path.relative(root, debPath) + ' && dpkg-deb -c ' + path.relative(root, debPath) + ' | head');
log('Install with:  sudo apt install ./' + path.relative(root, debPath));
