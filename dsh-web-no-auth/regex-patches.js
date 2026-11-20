/**
 * iPadOS 16.0-16.3 WebKit rejects regex lookbehind with
 * "Invalid regular expression: invalid group specifier name", which blanks the
 * whole DSH Web GUI because the plugin bundles are one module graph.
 *
 * A browser shim cannot help: those are regex literals, parsed before any
 * injected script runs, and the `/plugins/??...` bundle is served by a
 * single-owner prefix route a plugin cannot rewrite. So this module edits the
 * installed client bundles in place, keeps one `.pre-ipad16.bak` per file, and
 * asks `clientModules` to republish so enabling/disabling needs no restart.
 *
 * ponytail: edits are literal and verified by count; a DSH or dsh-genui upgrade
 * replaces the files, but this plugin re-patches them on the next activation.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Suffix of the single backup kept beside each patched bundle. */
export const BACKUP_SUFFIX = '.pre-ipad16.bak';

/**
 * Rewrites that remove lookbehind while keeping the code paths working.
 * Each edit is [find, replace, expectedOccurrences].
 */
export const PATCHES = [
  {
    id: '@deepseek-ai/dsh-client-ui-skill',
    edits: [
      ['const tokens = /(?<!\\S)\\/([\\w-]+)(?!\\S)/gu;', 'const tokens = /(^|\\s)\\/([\\w-]+)(?!\\S)/gu;', 1],
      ['const name = token[1];', 'const name = token[2];', 1],
      ['start: token.index,', 'start: token.index + token[1].length,', 1]
    ]
  },
  {
    id: '@deepseek-ai/dsh-client-ui-reference',
    edits: [
      ['const tokens = /(?<!\\S)(@"[^"\\n]+"|@[^\\s]+)/gu;', 'const tokens = /(^|\\s)(@"[^"\\n]+"|@[^\\s]+)/gu;', 1],
      ['\t\t\t\tconst token = match[0];', '\t\t\t\tconst offset = match.index + match[1].length;\n\t\t\t\tconst token = match[2];', 1],
      ['\t\t\t\t\tstart: match.index,', '\t\t\t\t\tstart: offset,', 1],
      ['\t\t\t\t\tend: match.index + raw.length,', '\t\t\t\t\tend: offset + raw.length,', 1]
    ]
  },
  {
    id: '@deepseek-ai/dsh-client-ui-goal',
    edits: [
      ['const slash = /(?<!\\S)\\//gu;', 'const slash = /(?:^|\\s)\\//u;', 1]
    ]
  },
  {
    id: '@changfenhuang/dsh-genui',
    edits: [
      ['(?<!\u0060)', '', 1],
      ['(?<![\\\\$])', '', 2],
      ['(?<!\\s)', '', 1]
    ]
  },
  {
    // Owner-requested layout behavior (2026-11-19): free-size the left sidebar
    // (no 264-420 clamp) and remember its width in localStorage across hard
    // refresh. Literal-tabbed finds, verified by count; a DSH upgrade replaces
    // the bundle and this patch re-applies on the next activation.
    id: '@deepseek-ai/dsh-client-ui-layout',
    edits: [
      ['\t\t\tconst s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, 264, 420);', '\t\t\tconst s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, 0, 1e9);', 1],
      ['\t\t\t\t\t\td.layoutInfo.sidebar = clampWidth(px, 264, 420);', '\t\t\t\t\t\td.layoutInfo.sidebar = clampWidth(px, 0, 1e9);\n\t\t\t\t\t\tlocalStorage.setItem("dsh.sidebarWidth", String(d.layoutInfo.sidebar));', 1],
      ['\t\t\t\t\t\tsidebar: 280,', '\t\t\t\t\t\tsidebar: Number(localStorage.getItem("dsh.sidebarWidth")) || 280,', 1],
      ['\t\t\t\t\t\telse d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? 280 : 0;', '\t\t\t\t\t\telse d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? (Number(localStorage.getItem("dsh.sidebarWidth")) || 280) : 0;', 1],
      ['\t\t\tconst available = viewport - s - 400;', '\t\t\tconst available = viewport - s;', 1],
      ['\t\t\tconst r = rightbar === 0 || available < 300 ? 0 : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));', '\t\t\tconst r = rightbar === 0 || available <= 0 ? 0 : Math.min(available, clampWidth(rightbar, 0, Number.MAX_SAFE_INTEGER));', 1],
      ['\t\t\tconst rightbarMax = cols.rightbar === 0 ? 0 : clampWidth(rightbarPreference, 300, viewport * RIGHTBAR_MAX_RATIO);', '\t\t\tconst rightbarMax = cols.rightbar === 0 ? 0 : clampWidth(rightbarPreference, 0, Number.MAX_SAFE_INTEGER);', 1],
      ['\t\t\t\t\t\td.layoutInfo.rightbar = clampWidth(px, 300, Math.max(300, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO));', '\t\t\t\t\t\td.layoutInfo.rightbar = clampWidth(px, 0, d.layoutInfo.viewportWidth);\n\t\t\t\t\t\tlocalStorage.setItem("dsh.rightbarWidth", String(d.layoutInfo.rightbar));', 1],
      ['\t\t\t\t\t\td.layoutInfo.rightbar ??= Math.max(300, Math.round(d.layoutInfo.viewportWidth * RIGHTBAR_DEFAULT_RATIO));', '\t\t\t\t\t\td.layoutInfo.rightbar ??= Number(localStorage.getItem("dsh.rightbarWidth")) || Math.max(300, Math.round(d.layoutInfo.viewportWidth * RIGHTBAR_DEFAULT_RATIO));', 1],
      ['\t\t\t\t\tgridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`', '\t\t\t\t\tgridTemplateColumns: `${cols.sidebar}px minmax(0px, 1fr) minmax(0px, ${rightbarMax}px)`', 1]
    ]
  }
];

/**
 * Bundle path for one package, or undefined when the plugin is not installed.
 *
 * @param {object} clientModules - DSH client module registry service.
 * @param {string} id - installed package name.
 * @returns {string | undefined} absolute path of its client bundle.
 */
function bundlePath(clientModules, id) {
  return typeof clientModules?.clientPath === 'function' ? clientModules.clientPath(id) : undefined;
}

/**
 * Republish a bundle so the browser receives the just-written bytes.
 *
 * @param {object} clientModules - DSH client module registry service.
 * @param {string} id - installed package name.
 */
function republish(clientModules, id) {
  if (typeof clientModules?.rebuilt === 'function') clientModules.rebuilt(id);
}

/**
 * Remove lookbehind from every installed bundle that still has it.
 *
 * @param {object} clientModules - DSH client module registry service.
 * @param {Function} warn - logger for skips.
 * @returns {string[]} package ids that were changed and republished.
 */
export function applyClientPatches(clientModules, warn = () => {}) {
  const changed = [];
  for (const patch of PATCHES) {
    const path = bundlePath(clientModules, patch.id);
    if (path === undefined || !existsSync(path)) {
      warn(`dsh-web-no-auth: ${patch.id} has no client bundle here; skipping its iPadOS patch`);
      continue;
    }
    const source = readFileSync(path, 'utf8');
    if (!patch.edits.some(([find]) => source.includes(find))) continue;
    let next = source;
    let complete = true;
    for (const [find, replace, expected] of patch.edits) {
      const found = next.split(find).length - 1;
      if (found !== expected) {
        warn(`dsh-web-no-auth: ${patch.id} patch skipped; expected ${expected} of ${JSON.stringify(find.slice(0, 40))}, found ${found}`);
        complete = false;
        break;
      }
      next = next.split(find).join(replace);
    }
    if (!complete) continue;
    if (!existsSync(path + BACKUP_SUFFIX)) copyFileSync(path, path + BACKUP_SUFFIX);
    writeFileSync(path, next);
    republish(clientModules, patch.id);
    changed.push(patch.id);
  }
  return changed;
}

/**
 * Put the original bundles back, for when the plugin is disabled.
 *
 * @param {object} clientModules - DSH client module registry service.
 * @returns {string[]} package ids that were restored and republished.
 */
export function restoreClientPatches(clientModules) {
  const restored = [];
  for (const patch of PATCHES) {
    const path = bundlePath(clientModules, patch.id);
    if (path === undefined || !existsSync(path + BACKUP_SUFFIX)) continue;
    copyFileSync(path + BACKUP_SUFFIX, path);
    republish(clientModules, patch.id);
    restored.push(patch.id);
  }
  return restored;
}
