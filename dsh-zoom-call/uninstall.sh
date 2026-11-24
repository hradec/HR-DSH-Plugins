#!/usr/bin/env bash
# dsh-zoom-call uninstaller — full revert, also the recovery path if the
# plugin ever blocks DSH boot. Restores package.json from the backup written
# by install.sh, drops the symlink, and cleans any stray state files it can
# find in workspaces (those are plain JSON cast files; left in place unless
# --purge is given).
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/web}"
PKG="$PROFILE/package.json"
PKG_ID="@local/dsh-zoom-call"

if [ -f "$PKG.bak-zoom-call" ]; then
  cp "$PKG.bak-zoom-call" "$PKG"
  echo "restored $PKG from $PKG.bak-zoom-call"
elif [ -f "$PKG" ]; then
  # No backup: surgically remove our own entries, leave everything else alone.
  node - "$PKG" "$PKG_ID" <<'EOF'
const fs = require('fs')
const [pkgPath, pkgId] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
delete pkg.dependencies?.[pkgId]
const bundles = pkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((id) => id !== pkgId)
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
EOF
  echo "removed $PKG_ID entries from $PKG (no backup existed)"
else
  echo "no profile package.json at $PKG — nothing to do" >&2
fi

rm -f "$PROFILE/node_modules/@local/dsh-zoom-call"

if [ "${1:-}" = "--purge" ]; then
  echo "purge: removing .zoom-call.cast.json/.bak under $PLUGIN_DIR only is not automatic — cast files live in project workspaces; delete <workspace>/.zoom-call.cast.json by hand where wanted"
fi

echo
echo "Uninstalled. Restart the harness socket-first to complete the removal."
