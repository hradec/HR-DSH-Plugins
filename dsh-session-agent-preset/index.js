/**
 * dsh-session-agent-preset — Host endpoint for changing a live Session preset.
 *
 * The built-in select method is intentionally blank-session-only. This endpoint
 * uses the registry's composition operation inside Agent maintenance, then
 * records the same durable selection event DSH uses during blank-session setup.
 * The idle maintenance claim prevents a concurrent turn from seeing a partial
 * tool/prompt composition change.
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

// Resolve against the running DSH installation, not this external plugin folder.
const launcher = process.env.DSH_SESSION_AGENT_PRESET_ENTRY ?? process.argv[1]
if (launcher === undefined) throw new Error('dsh-session-agent-preset: cannot resolve the DSH runtime entry')
const dshRequire = createRequire(realpathSync(launcher))
const { TypertRemoteService, Remote, RemoteError } = await import(dshRequire.resolve('@deepseek-ai/dsh-typert-protocol'))

const CODE = {
  badRequest: 'session-agent-preset/bad-request',
  notFound: 'session-agent-preset/session-not-found',
  active: 'session-agent-preset/session-active',
  invalid: 'session-agent-preset/preset-invalid',
  failed: 'session-agent-preset/switch-failed',
}

/** Build a stable Gateway-safe failure. */
function failure(code, message, details = {}) {
  return new RemoteError(code, message, details)
}

/**
 * Recompose a live idle Agent and durably record the selected preset.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host root context.
 * @param {string} sessionId - target Session/Agent id.
 * @param {string} agentPreset - declared preset id.
 * @returns {Promise<{sessionId: string, agentPreset: string}>} committed selection.
 */
async function changeSessionPreset(ctx, sessionId, agentPreset) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw failure(CODE.badRequest, 'sessionId must be a non-empty string')
  if (typeof agentPreset !== 'string' || agentPreset.length === 0) throw failure(CODE.badRequest, 'agentPreset must be a non-empty string')

  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw failure(CODE.notFound, 'this session is not currently attached to a live Agent', { sessionId })
  if (agent.status !== 'idle') throw failure(CODE.active, 'wait for the current turn to finish before changing its preset', { sessionId })

  const presets = ctx.agentPresets
  try {
    // Claim the Agent's true idle phase. Waking input queues behind this short
    // maintenance task, so the new turn observes the fully committed preset.
    return await agent.runMaintenance(async () => {
      if (agent.status !== 'idle') throw failure(CODE.active, 'wait for the current turn to finish before changing its preset', { sessionId })
      let resolved
      try {
        resolved = await presets.resolve(agentPreset)
      } catch (error) {
        throw failure(CODE.invalid, `preset "${agentPreset}" is unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId, agentPreset })
      }
      if (resolved.broken !== undefined) throw failure(CODE.invalid, `preset "${agentPreset}" is unavailable: ${resolved.broken}`, { sessionId, agentPreset })

      const previous = presets.composedPreset(agent.ctx)
      const committed = await presets.recompose(agent.ctx, resolved.id)
      try {
        agent.session.append('agent-preset/selected', { agentPreset: committed.id })
      } catch (error) {
        // Keep memory and the durable log aligned if the append is rejected.
        if (previous !== undefined) await presets.recompose(agent.ctx, previous).catch(() => {})
        throw error
      }
      return { sessionId, agentPreset: committed.id }
    })
  } catch (error) {
    if (error?.isDSHRemoteError === true) throw error
    if (error instanceof Error && /maintenance|idle|running/i.test(error.message)) {
      throw failure(CODE.active, 'wait for the current turn to finish before changing its preset', { sessionId })
    }
    throw failure(CODE.failed, `could not switch this session's preset: ${error instanceof Error ? error.message : String(error)}`, { sessionId, agentPreset })
  }
}

/** Host service declaring `sessionAgentPreset/change`. */
class SessionAgentPreset extends TypertRemoteService {
  static inject = ['agents', 'agentPresets']

  constructor(ctx) {
    super(ctx, 'sessionAgentPreset')
  }

  /** Select and record a preset for one idle live Session. */
  change(sessionId, agentPreset) {
    return changeSessionPreset(this.ctx, sessionId, agentPreset)
  }
}

// Plain JavaScript equivalent of the compiled package's @Remote decorator.
{
  const proto = SessionAgentPreset.prototype
  Remote(proto.change, {
    private: false,
    static: false,
    name: 'change',
    addInitializer(initializer) {
      initializer.call(Object.create(proto))
    },
  })
}

export { changeSessionPreset }
export default SessionAgentPreset
