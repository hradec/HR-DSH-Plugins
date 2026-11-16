/**
 * dsh-session-colors — Host half.
 *
 * Sidebar colors are presentation state that has to survive a browser switch,
 * so the Host owns the shared copy in `$DSH_HOME/session-colors.json`
 * (normally `~/.dsh/session-colors.json`). The browser keeps a localStorage
 * cache for an instant first paint and calls this endpoint to read and write
 * the shared copy.
 *
 * Exposed to the browser as the Remote namespace `sessionColors` with `read`
 * and `write`; the client reaches it through `ctx.connection.rpc`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'

// This package lives outside the profile's node_modules, so bare @deepseek-ai
// imports would resolve from this directory and fail. Resolve the running
// Host's own copies instead.
// ponytail: depends on process.argv[1] being the dsh launcher entry, which the
// documented activation path always provides.
const launcher = process.env.DSH_SESSION_COLORS_ENTRY ?? process.argv[1]
if (launcher === undefined) throw new Error('dsh-session-colors: cannot resolve the DSH runtime entry (process.argv[1])')
const dshRequire = createRequire(realpathSync(launcher))
const { TypertRemoteService, Remote, RemoteError } = await import(dshRequire.resolve('@deepseek-ai/dsh-typert-protocol'))

/** Shared color store, next to the rest of the user's Harness state. */
const STORE_PATH = path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'session-colors.json')
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i
// ponytail: the ceiling only stops a runaway payload; real sidebars are tiny.
const MAX_ENTRIES = 2048

/** Stable Remote failure codes this plugin owns. */
const CODE = {
  badRequest: 'session-colors/bad-request',
  writeFailed: 'session-colors/write-failed',
}

/**
 * Copy only plain id -> #rrggbb records from an untrusted value.
 * @param {unknown} value - browser-supplied map or a parsed file section.
 * @returns {Record<string, string>} the valid subset, lowercased.
 */
function parseMap(value) {
  const next = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return next
  for (const [key, color] of Object.entries(value)) {
    if (Object.keys(next).length >= MAX_ENTRIES) break
    if (key.length === 0 || typeof color !== 'string' || !COLOR_PATTERN.test(color)) continue
    next[key] = color.toLowerCase()
  }
  return next
}

/**
 * Read the shared store; a missing or unreadable file reads as empty so one
 * corrupt write can never leave the sidebar unusable.
 * @returns {Promise<{sessions: Record<string, string>, folders: Record<string, string>}>} both maps.
 */
async function readStore() {
  let raw = null
  try {
    raw = await readFile(STORE_PATH, 'utf8')
  } catch {
    return { sessions: {}, folders: {} }
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { sessions: {}, folders: {} }
  }
  return { sessions: parseMap(parsed?.sessions), folders: parseMap(parsed?.folders) }
}

// ponytail: a per-call suffix keeps two overlapping writes (and two Host
// processes) from renaming each other's temporary file.
let writeCount = 0

/**
 * Replace the shared store atomically: a temporary sibling then a rename, so a
 * crash leaves the previous file intact instead of a truncated map.
 * @param {{sessions: Record<string, string>, folders: Record<string, string>}} payload - validated maps.
 * @returns {Promise<void>} resolves once the new file is in place.
 */
async function writeStore(payload) {
  writeCount += 1
  const temporary = `${STORE_PATH}.${process.pid}.${writeCount}.tmp`
  try {
    await mkdir(path.dirname(STORE_PATH), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporary, STORE_PATH)
  } catch (error) {
    throw new RemoteError(CODE.writeFailed, `session colors could not be saved: ${error.message}`, { path: STORE_PATH })
  }
}

// ponytail: one promise chain serializes writes, so two browsers saving at once
// cannot interleave read-modify-write. Ordered, not locked: last save wins.
let writeTail = Promise.resolve()

/**
 * Queue one atomic store replacement behind any in-flight write.
 * @param {{sessions: object, folders: object}} payload - validated maps.
 * @returns {Promise<void>} resolves after this payload is on disk.
 */
function queueWrite(payload) {
  const run = writeTail.then(() => writeStore(payload), () => writeStore(payload))
  writeTail = run.then(() => undefined, () => undefined)
  return run
}

/** Host owner of the shared sidebar-color maps. */
class SessionColors extends TypertRemoteService {
  static inject = []

  /** @param {import('@deepseek-ai/cordis').Context} ctx - Host context. */
  constructor(ctx) {
    super(ctx, 'sessionColors')
  }

  /**
   * Read the shared maps every browser should show.
   * @returns {Promise<{sessions: Record<string, string>, folders: Record<string, string>}>} both maps.
   */
  read() {
    return readStore()
  }

  /**
   * Replace the shared maps with this browser's current state.
   *
   * The typert Gateway matches `args` field names against this method's
   * parameter names, so the browser sends the maps under `request`; a flat
   * `{sessions, folders}` payload is rejected before reaching this method.
   * @param {{sessions?: unknown, folders?: unknown}} request - untrusted browser maps.
   * @returns {Promise<{sessions: Record<string, string>, folders: Record<string, string>}>} what was stored.
   */
  write(request) {
    if (request === null || typeof request !== 'object') throw new RemoteError(CODE.badRequest, 'payload must be an object', {})
    const payload = { sessions: parseMap(request.sessions), folders: parseMap(request.folders) }
    return queueWrite(payload).then(() => payload)
  }
}

// The package ships plain JavaScript, so mark the endpoints with the same
// decorator the compiled packages use, invoked directly instead of through
// decorator syntax.
// ponytail: mirrors `@Remote`; revisit if dsh-typert-protocol changes its
// decorator context contract.
{
  const proto = SessionColors.prototype
  for (const name of ['read', 'write']) {
    Remote(proto[name], {
      private: false,
      static: false,
      name,
      addInitializer(initializer) {
        initializer.call(Object.create(proto))
      },
    })
  }
}

export { parseMap, readStore, writeStore, STORE_PATH }
export default SessionColors
