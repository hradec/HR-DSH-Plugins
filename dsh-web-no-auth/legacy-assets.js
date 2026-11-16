/**
 * Make the shipped frontend parse on iPadOS 16.0-16.3 WebKit.
 *
 * Two gaps are handled generically, so nothing here is tied to a bundle hash:
 *  - class static blocks (`static{...}`, supported from iPadOS 16.4) are lowered
 *    with esbuild's `safari16` target;
 *  - lookbehind inside `new RegExp("...")` strings is rewritten to a consuming
 *    group, because a string-built regex cannot be shimmed by the browser.
 *
 * Regex *literals* with lookbehind live in plugin client bundles, not these
 * assets; `regex-patches.js` handles those. Assets are discovered from the
 * installed frontend dist on every activation, so a DSH upgrade needs no edit
 * here.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Class static block syntax that iPadOS 16.0-16.3 rejects. */
const STATIC_BLOCK = /\bstatic\s*\{/;
/** A RegExp built from a string literal that still contains lookbehind. */
const REGEXP_CONSTRUCTOR = /new RegExp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
/**
 * Lookbehind regex *literals* the frontend evaluates at startup. A literal is
 * parsed before any script can run, so the only safe repair is a rule that
 * never matches; the affected feature degrades instead of blanking the page.
 */
const KNOWN_LITERAL_LOOKBEHINDS = [
  { match: '/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu', replacement: '/(?!)/gu' },
  { match: '/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/g', replacement: '/(?!)/g' }
];

/**
 * Strip lookbehind from `new RegExp("...")` string literals.
 *
 * ponytail: a string-built lookbehind cannot be lowered to an exact equivalent
 * without a regex compiler, so it becomes a consuming group. That keeps the
 * asset parsing and the feature working; match offsets shift slightly in the
 * few places that use this (markdown inline autolinking).
 *
 * @param {string} source - asset source text.
 * @returns {string} source with string-built lookbehind removed.
 */
export function neutraliseBuiltLookbehind(source) {
  let next = source.replace(REGEXP_CONSTRUCTOR, (whole, literal) => {
    if (!literal.includes('(?<=') && !literal.includes('(?<!')) return whole;
    return whole.replace(literal, literal.split('(?<=').join('(?:').split('(?<!').join('(?:'));
  });
  for (const rule of KNOWN_LITERAL_LOOKBEHINDS) next = next.split(rule.match).join(rule.replacement);
  return next;
}

/**
 * Report lookbehind regex literals this module cannot rewrite.
 *
 * @param {string} source - asset source text.
 * @returns {number} count of lookbehind groups still present outside JSON strings.
 */
export function countRemainingLookbehind(source) {
  let count = 0;
  for (let at = source.indexOf('(?<'); at !== -1; at = source.indexOf('(?<', at + 3)) {
    const after = source[at + 3];
    if (after !== '=' && after !== '!') continue;
    // JSON grammar payloads keep their escapes; those are data, not live regexes.
    const before = source.slice(Math.max(0, at - 40), at);
    if (before.includes('\\\\')) continue;
    count += 1;
  }
  return count;
}

/**
 * Locate the installed frontend dist directory.
 *
 * @returns {string | undefined} absolute dist path containing index.html.
 */
export function locateDist() {
  const entry = process.argv[1];
  const roots = [];
  if (typeof entry === 'string') {
    try {
      const require = createRequire(entry);
      const manifest = require.resolve('@deepseek-ai/dsh-web-frontend/package.json');
      roots.push(join(dirname(manifest), 'dist'));
    } catch {
      // Fall through to the path-derived candidates below.
    }
    const dshRoot = dirname(dirname(entry));
    roots.push(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'));
    roots.push(join(dshRoot, '..', 'dsh-web-frontend', 'dist'));
  }
  for (const root of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof root !== 'string') continue;
    roots.push(join(root, 'runtime', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'));
    roots.push(join(root, 'runtime', 'lib', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'));
  }
  for (const candidate of roots) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

/**
 * Resolve the local esbuild build API (used only for static-block lowering).
 *
 * @returns {{ transformSync: Function } | undefined} esbuild module when found.
 */
export function locateEsbuild() {
  const entry = process.argv[1];
  const candidates = [];
  if (typeof entry === 'string') {
    const dshRoot = dirname(dirname(entry));
    candidates.push(join(dshRoot, 'node_modules', 'esbuild'));
    try {
      candidates.push(dirname(createRequire(entry).resolve('esbuild/package.json')));
    } catch {
      // dsh does not depend on esbuild directly; use the bundled copies below.
    }
  }
  for (const home of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof home !== 'string') continue;
    candidates.push(join(home, 'profiles', 'web', 'node_modules', 'dsh-director', 'node_modules', 'esbuild'));
    candidates.push(join(home, 'custom-plugins', 'dsh-director', 'node_modules', 'esbuild'));
  }
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, 'package.json'))) continue;
    try {
      return createRequire(join(candidate, 'package.json'))('esbuild');
    } catch {
      // Try the next installed copy; a missing build API only costs static blocks.
    }
  }
  return undefined;
}

/**
 * Discover, transform, and describe the frontend assets iPadOS 16 cannot parse.
 *
 * @param {Function} warn - logger for assets that could not be transformed.
 * @returns {{ routes: Map<string, Buffer>, applyIndex: (html: string) => string }} served overrides and an index rewriter.
 */
export function buildLegacyAssets(warn = () => {}) {
  const routes = new Map();
  const index = new Map();
  const dist = locateDist();
  if (dist === undefined) {
    warn('dsh-web-no-auth: frontend dist not found; iPadOS 16 asset lowering skipped');
    return { routes, applyIndex: (html) => html };
  }
  const assets = join(dist, 'assets');
  const names = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith('.js')) : [];
  const esbuild = names.some((name) => STATIC_BLOCK.test(readFileSync(join(assets, name), 'utf8'))) ? locateEsbuild() : undefined;
  const lowered = new Map();
  for (const name of names) {
    const source = readFileSync(join(assets, name), 'utf8');
    let body = neutraliseBuiltLookbehind(source);
    if (STATIC_BLOCK.test(body)) {
      if (esbuild === undefined) {
        warn(`dsh-web-no-auth: ${name} needs static-block lowering but esbuild is unavailable; iPadOS 16 will fail to parse it`);
        continue;
      }
      body = esbuild.transformSync(body, { target: 'safari16', format: 'esm', loader: 'js', legalComments: 'none' }).code;
      body = neutraliseBuiltLookbehind(body);
    }
    if (body === source) continue;
    lowered.set(name, body);
    index.set(name, createHash('sha256').update(body).digest('hex').slice(0, 12));
  }
  // Rewrite references between lowered assets so a stale cached chunk cannot be
  // pulled back in by an already-served importer.
  for (const [name, body] of lowered) {
    let next = body;
    for (const [other, rev] of index) {
      if (other === name) continue;
      next = next.split(`./${other}`).join(`./${other}?legacy=${rev}`);
    }
    routes.set(`/assets/${name}`, Buffer.from(next));
  }
  return {
    routes,
    applyIndex(html) {
      let next = html;
      for (const [name, rev] of index) next = next.split(`assets/${name}`).join(`assets/${name}?legacy=${rev}`);
      return next;
    }
  };
}
