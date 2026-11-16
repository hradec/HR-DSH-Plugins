/**
 * Deliberately remove all DSH Web browser authentication.
 *
 * ponytail: this mutates DSH's in-process Connection service because the
 * upstream package intentionally has no unauthenticated configuration mode.
 * Every request reaching the listener receives the owner peer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyClientPatches, restoreClientPatches } from './regex-patches.js';
import { buildLegacyAssets, locateDist } from './legacy-assets.js';

export const name = 'dsh-web-no-auth';
export const inject = ['connection', 'webServer', 'clientModules'];

const IPAD_COMPAT = new URL('./ipad-compat.js', import.meta.url);

/**
 * Bypass the bootstrap-token, cookie, and Host/Origin checks for this process.
 *
 * @param {object} ctx Cordis context carrying the Connection service.
 */
export function apply(ctx) {
  const connection = ctx.connection;
  // Anything the automatic patching could not repair is surfaced in the browser
  // instead of failing as a blank page.
  const issues = [];
  const report = (message) => {
    issues.push(message);
    ctx.logger?.warn(message);
  };

  // iPadOS 16.0-16.3 cannot parse lookbehind, and those regexes live in the
  // served client bundles, so patch them on enable and restore them on disable.
  ctx.effect(() => {
    const changed = applyClientPatches(ctx.clientModules, report);
    if (changed.length > 0) console.warn(`dsh-web-no-auth: patched iPadOS-rejected regexes in ${changed.join(', ')}`);
    return () => {
      const restored = restoreClientPatches(ctx.clientModules);
      if (restored.length > 0) console.warn(`dsh-web-no-auth: restored original regexes in ${restored.join(', ')}`);
    };
  }, 'dsh-web-no-auth: iPadOS lookbehind patches');

  // Older iPadOS WebKit lacks AbortSignal.any / throwIfAborted, Object.groupBy,
  // Set methods, Uint8Array base64 helpers and others the frontend calls. The
  // shim is a separate file so it needs no nested-string escaping here.
  ctx.on('webserver/index-inject', (table) => {
    const shim = readFileSync(IPAD_COMPAT, 'utf8');
    const prelude = issues.length === 0 ? '' : `globalThis.__DSH_IPAD_COMPAT_WARNINGS__ = ${JSON.stringify(issues)};\n`;
    table.push({ kind: 'script', placement: 'head', text: prelude + shim });
  });

  // The shipped frontend uses class static blocks (iPadOS 16.4+) and may build
  // a lookbehind regex from a string. Both are discovered from the installed
  // dist at activation, so a DSH upgrade needs no edit here.
  const legacy = buildLegacyAssets(report);
  ctx.effect(() => ctx.webServer.tapIndex(legacy.applyIndex), 'dsh-web-no-auth: iPadOS asset cache-bust');
  for (const [path, body] of legacy.routes) ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    }
  }), `dsh-web-no-auth: lowered asset ${path}`);
  if (legacy.routes.size > 0) console.warn(`dsh-web-no-auth: lowered ${legacy.routes.size} frontend asset(s) for iPadOS 16`);

  // The index must never be cached: a cached copy keeps pointing at pre-patch
  // bundle revisions, which is how an old incompatible bundle comes back to life.
  const dist = locateDist();
  if (dist !== undefined && existsSync(join(dist, 'index.html'))) {
    const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/',
      handler: (_request, response) => {
        const rendered = ctx.webServer.renderIndex(indexHtml)
          .replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="./">`);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(rendered);
      }
    }), 'dsh-web-no-auth: uncached index');
  } else {
    report('dsh-web-no-auth: frontend dist not found; index cache-control left to DSH');
  }

  // The static frontend calls this dynamically for each index request.
  connection.authorizeIndex = () => true;

  // The API and websocket transport call these dynamically for every request.
  connection.isTrusted = () => true;
  connection.admit = () => {
    if (connection.disposed) return { rejection: 401 };
    return { peer: connection.browserPeer };
  };

  // Keep the startup URL clean; no bootstrap credential is required anymore.
  connection.authenticatedUrl = (baseUrl) => baseUrl;

  console.warn('dsh-web-no-auth: browser authentication and origin checks are disabled');
}
