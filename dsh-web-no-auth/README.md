# dsh-web-no-auth

Local DSH Web host plugin with two jobs, both behind the plugin panel's
enable/disable switch.

## 1. No browser authentication

Disables the launch token, browser-session cookie, and Host/Origin trust fence by
overriding the live `connection` service: every client that reaches the listener
gets the owner peer. **That means unauthenticated remote code execution for
anyone who can reach port 3080** — keep it on a trusted network.

## 2. iPadOS 16.0-16.3 compatibility (self-healing)

Those WebKit versions cannot parse class static blocks or regex lookbehind, and
they lack `AbortSignal.any` and friends. Everything is applied automatically on
each activation, so a DSH or `dsh-genui` upgrade needs no manual edit:

| Layer | File | How it stays correct |
| --- | --- | --- |
| Regex literals in client bundles | `regex-patches.js` | Patches each installed bundle via `clientModules.clientPath()`, keeps one `.pre-ipad16.bak`, then `clientModules.rebuilt()` publishes it live. Restores on disable. |
| Frontend assets | `legacy-assets.js` | Discovers the installed dist, lowers static blocks with esbuild `safari16`, rewrites string-built lookbehind, and cache-busts the index by content hash. |
| Missing browser APIs | `ipad-compat.js` | Head script polyfills `AbortSignal.any`/`throwIfAborted`, `Promise.withResolvers`, `Object.hasOwn`/`groupBy`, `Map.groupBy`, `Array.fromAsync`, Array copy methods, Set set-ops, `Uint8Array` base64, `structuredClone`, `crypto.randomUUID`, `requestIdleCallback`, non-secure-context `navigator.clipboard`. |

If a future upgrade changes something the automatic patching cannot repair, the
plugin pushes the details into `__DSH_IPAD_COMPAT_WARNINGS__` and the browser
shows a dismissible red bar naming the problem, instead of a blank page.

Ceilings: the asset lowering needs an installed esbuild (taken from `dsh-director`);
lookbehind inside a *string* becomes a consuming group, so match offsets can
shift slightly in that one markdown autolink rule; and the plain-HTTP origin is
not a secure context, so clipboard/subtle-crypto stay limited regardless.
