/**
 * dsh-session-mover — Host half.
 *
 * A DSH session's Workspace membership is derived from the directory recorded
 * in its immutable header, so no public API can "move" a session between
 * folders. This service implements the user-visible move as a durable copy:
 *
 *   1. validate the target Workspace;
 *   2. archive the source (a running session is refused before anything is
 *      copied, so the original is never stopped behind the user's back);
 *   3. read the source log and build the exact fork seed for its last event;
 *   4. create a new session whose recorded cwd is the target directory, using
 *      the source's Agent preset and model selection;
 *   5. attach that session to the target Workspace.
 *
 * The original stays in the archive set (recoverable from the archived view),
 * and the copy carries the complete source history, so no context is lost.
 *
 * Exposed to the browser as the SRC-mode Remote endpoint
 * `sessionMover/move`; the client calls it through `ctx.connection.rpc`.
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

// This package lives outside the profile's node_modules, so bare @deepseek-ai
// imports would resolve from this directory's realpath and fail. Resolve the
// running Host's own copies instead.
// ponytail: depends on process.argv[1] being the dsh launcher entry (or the
// test override naming one). The documented activation path always has it.
const launcher = process.env.DSH_SESSION_MOVER_ENTRY ?? process.argv[1]
if (launcher === undefined) throw new Error('dsh-session-mover: cannot resolve the DSH runtime entry (process.argv[1])')
const dshEntry = realpathSync(launcher)
const dshRequire = createRequire(dshEntry)
const { TypertRemoteService, Remote, RemoteError } = await import(dshRequire.resolve('@deepseek-ai/dsh-typert-protocol'))
const { buildForkSeed } = await import(dshRequire.resolve('@deepseek-ai/dsh-session/fork'))

/** Stable Remote failure codes this plugin owns. */
const CODE = {
  badRequest: 'session-mover/bad-request',
  notFound: 'session-mover/not-found',
  targetNotFound: 'session-mover/target-not-found',
  targetMissing: 'session-mover/target-missing',
  alreadyThere: 'session-mover/already-there',
  sourceActive: 'session-mover/source-active',
  archiveFailed: 'session-mover/archive-failed',
  readFailed: 'session-mover/read-failed',
  empty: 'session-mover/empty',
  copyFailed: 'session-mover/copy-failed',
  attachFailed: 'session-mover/attach-failed',
  unsupported: 'session-mover/unsupported',
}

/**
 * Build one stable Remote failure.
 * @param {string} code - stable code from {@link CODE}.
 * @param {string} message - human diagnostic.
 * @param {object} [details] - structured payload.
 * @returns {Error} a RemoteError the Gateway encodes unchanged.
 */
function failure(code, message, details = {}) {
  return new RemoteError(code, message, details)
}

/**
 * Move one session by copying its complete history into the target Workspace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host root context.
 * @param {string} sessionId - source Session.
 * @param {string} targetWorkspaceId - existing target Workspace.
 * @returns {Promise<{sessionId: string, sourceSessionId: string, targetWorkspaceId: string, targetPath: string, copiedEvents: number}>}
 */
async function moveSession(ctx, sessionId, targetWorkspaceId) {
  const registry = ctx.workspaceRegistry
  const target = registry.get(targetWorkspaceId)
  if (target === undefined) throw failure(CODE.targetNotFound, `target folder "${targetWorkspaceId}" is not registered`, { workspaceId: targetWorkspaceId })

  const sourceOwner = registry.list().find((workspace) => workspace.sessionIds.includes(sessionId))
  if (sourceOwner !== undefined && sourceOwner.id === target.id) throw failure(CODE.alreadyThere, 'the session is already in this folder', { sessionId, workspaceId: target.id })

  const status = await target.status()
  if (status !== 'ok') throw failure(CODE.targetMissing, `target folder "${target.path}" no longer exists`, { workspaceId: target.id, path: target.path })

  // Archive first: a refused archive (running work) means nothing was copied.
  try {
    await registry.archiveSession(sessionId)
  } catch (error) {
    if (error?.name === 'WorkspaceActiveSessionError') {
      throw failure(CODE.sourceActive, 'the session is still running; stop it before moving it', { sessionId, activity: error.activity ?? [] })
    }
    if (error?.name === 'WorkspaceUnknownSessionError') throw failure(CODE.notFound, `session "${sessionId}" was not found`, { sessionId })
    throw failure(CODE.archiveFailed, `could not archive the source session: ${error instanceof Error ? error.message : String(error)}`, { sessionId })
  }

  let observation
  let handle
  try {
    try {
      observation = await ctx.sessionQuery.observeSession(sessionId)
    } catch (error) {
      throw failure(CODE.readFailed, `could not read the source session: ${error instanceof Error ? error.message : String(error)}`, { sessionId })
    }
    const events = observation.events
    if (events.length === 0) throw failure(CODE.empty, 'this session has no history to copy', { sessionId })
    const boundary = events[events.length - 1].seq
    const seed = buildForkSeed(events, boundary)

    // ponytail: reuse API Session's own composition helper so the copy keeps
    // the source preset and model selection exactly like a shipped fork. It is
    // a runtime field of this Host release, not a public service; the failure
    // mode below is a clean refusal instead of a half-configured copy.
    const helper = ctx.sessionController?.agents
    const composition = helper === undefined ? undefined : await helper.composeAgent(helper.presetForObservation(observation))
    if (composition === undefined) throw failure(CODE.unsupported, 'this Host no longer exposes the Agent composition needed to copy a session', {})

    const { provider, model } = ctx.agentDefaultModel.currentSelection()
    const childId = `session-${randomUUID()}`
    handle = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: boundary + 1,
      meta: {
        cwd: target.path,
        parentSession: sessionId,
        isSeeded: true,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      agentOptions: { provider, model },
      setup: composition.setup,
    })

    try {
      await target.attachSession(childId)
    } catch (error) {
      // Hide the orphan copy and leave the source usable again.
      await handle.dispose().catch(() => {})
      await registry.archiveSession(childId).catch(() => {})
      throw failure(CODE.attachFailed, `copied the history but could not file it under the target folder: ${error instanceof Error ? error.message : String(error)}`, { sessionId: childId, workspaceId: target.id })
    }

    return {
      sessionId: childId,
      sourceSessionId: sessionId,
      targetWorkspaceId: target.id,
      targetPath: target.path,
      copiedEvents: events.length,
    }
  } catch (error) {
    await registry.unarchiveSession(sessionId).catch(() => {})
    if (error?.isDSHRemoteError === true) throw error
    throw failure(CODE.copyFailed, `could not copy the session: ${error instanceof Error ? error.message : String(error)}`, { sessionId })
  } finally {
    observation?.[Symbol.dispose]?.()
  }
}

/**
 * Host service declaring the `sessionMover/move` Remote endpoint.
 */
class SessionMover extends TypertRemoteService {
  static inject = ['agents', 'agentDefaultModel', 'sessionQuery', 'sessionController', 'workspaceRegistry']

  /** @param {import('@deepseek-ai/cordis').Context} ctx - Host context. */
  constructor(ctx) {
    super(ctx, 'sessionMover')
  }

  /**
   * Copy one session into another folder and archive the original.
   * @param {string} sessionId - source Session.
   * @param {string} targetWorkspaceId - existing target Workspace.
   * @returns {Promise<object>} the new Session identity and copy facts.
   */
  move(sessionId, targetWorkspaceId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw failure(CODE.badRequest, 'sessionId must be a non-empty string', {})
    if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.length === 0) throw failure(CODE.badRequest, 'targetWorkspaceId must be a non-empty string', {})
    return moveSession(this.ctx, sessionId, targetWorkspaceId)
  }
}

// The package ships plain JavaScript, so mark the endpoint with the same
// decorator the compiled packages use, invoked directly instead of through
// decorator syntax.
// ponytail: mirrors `@Remote`; revisit if dsh-typert-protocol changes its
// decorator context contract.
{
  const proto = SessionMover.prototype
  Remote(proto.move, {
    private: false,
    static: false,
    name: 'move',
    addInitializer(initializer) {
      initializer.call(Object.create(proto))
    },
  })
}

export { moveSession }
export default SessionMover
