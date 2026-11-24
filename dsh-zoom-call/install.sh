#!/usr/bin/env bash
# dsh-zoom-call installer — registers the plugin in the web profile WITHOUT
# touching the running harness. Every mutation is backed up; uninstall.sh
# reverts it. Run this when you are ready to install (the harness restart is
# yours to trigger; see INSTALL.md for the socket-first order).
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/web}"
PKG="$PROFILE/package.json"
PKG_ID="@local/dsh-zoom-call"

if [ ! -f "$PKG" ]; then
  echo "not a profile (no package.json): $PROFILE" >&2
  exit 1
fi

# 1. backup once — repeated installs never overwrite the original backup
if [ ! -f "$PKG.bak-zoom-call" ]; then
  cp "$PKG" "$PKG.bak-zoom-call"
  echo "backup written: $PKG.bak-zoom-call"
fi

# 2. add the link dependency + the bundle entry (JSON-edited, never sed)
node - "$PKG" "$PKG_ID" "$PLUGIN_DIR" <<'EOF'
const fs = require('fs')
const [pkgPath, pkgId, pluginDir] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies[pkgId] = 'link:' + pluginDir
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
const bundles = pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
if (!bundles.includes(pkgId)) bundles.push(pkgId)
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
EOF
echo "registered $PKG_ID in $PKG"

# 3. materialize the dependency as a symlink (zero npm deps -> no install step)
mkdir -p "$PROFILE/node_modules/@local"
ln -sfn "$PLUGIN_DIR" "$PROFILE/node_modules/@local/dsh-zoom-call"
echo "symlink: $PROFILE/node_modules/@local/dsh-zoom-call -> $PLUGIN_DIR"

echo
echo "Done. The harness was NOT restarted and NO other session was touched."
echo "Activate it with a socket-first restart (see INSTALL.md), then open a"
echo "session and look for the 🎥 Cast button in the conversation header."
