/**
 * dsh-auto-continue — Host plugin.
 *
 * Resumes sessions the user left stuck on a recoverable failure:
 *
 * 1. INTERRUPTED — after a DSH restart, a session that was running keeps an
 *    OPEN tail turn; session-query balances it with synthetic
 *    `turn/end {reason:{kind:'interrupted'}}`, which the GUI shows as the
 *    "Task stopped — the turn was closed when DSH restarted" card. One scan
 *    per host start (boot + a few seconds) sends the configured prompt
 *    (default "continue") through the same Session Controller path the GUI
 *    send button uses.
 *
 * 2. TRANSIENT ERROR — a turn that died on a routable infrastructure error
 *    (default: router 503 "custom route has no reachable URL: every
 *    configured URL failed") closes with `turn/end {kind:'error', error}`.
 *    Those happen while the host lives, so a live `session/event` listener
 *    retries after `errorRetryDelaySeconds`, re-checking the tail first, with
 *    at most `maxErrorRetries` auto-retries per session per boot — a persistently
 *    dead router cannot loop forever. The boot scan also picks up error-closed
 *    sessions that were stuck before the restart.
 *
 * 3. OUTPUT-TRUNCATED — a reply cut off by the model's output-token limit
 *    closes with `turn/end {kind:'max-tokens'}`; the GUI card itself says
 *    "Send continue to let the model resume".
 *
 * 4. FAKE TOOL CALL — a model that PRINTS `<tool_call>…</tool_call>` as
 *    chat text instead of issuing the call ends its turn "completed" and the
 *    session stalls; the final assistant text of the last turn decides
 *    (`toolCallPattern`).
 *
 * The walk-back tail rule is the only condition: scan back to the last turn
 * boundary; trailing session/end-seed, job, and record events must not mask
 * the closer. A running session hits its own OPEN turn/start first and is
 * never injected into; a continued one hits a completed turn/end.
 *
 * Idempotent by construction: once a session has been continued, its tail
 * changes, so later scans never match it again.
 */

export const name = 'dsh-auto-continue'
export const inject = ['sessionQuery', 'sessionController']

/**
 * Read a finite number from raw patch config, falling back when absent.
 * @param {unknown} value - raw configured value.
 * @param {number} fallback - default when the value is missing or unusable.
 * @returns {number} the effective number.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Visible TEXT blocks of an assistant message (reasoning and tool_use inputs
 * deliberately excluded: a model QUOTING tool-call markup while explaining it
 * must not look like a fake call — the stall signature is printed-call TEXT).
 * @param {object|undefined} data - assistant/message event data.
 * @returns {string} joined visible text.
 */
function assistantVisibleText(data) {
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
}

/**
 * Find the last turn-closing event worth resuming, walking back over trailing
 * noise (session/end-seed from GUI live-promotion, job/record events).
 * @param {readonly object[]} events - observation events (closers already folded).
 * @param {RegExp} errorPattern - errors considered transient and worth retrying.
 * @param {RegExp} toolCallPattern - literal tool-call markup a model printed as text.
 * @returns {object|null} the closer event to resume, or null when the session is running, completed cleanly, failed deterministically, or delegated-safe-skipped by the caller.
 */
function resumeCloser(events, errorPattern, toolCallPattern) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'turn/start') return null // an open turn is running (or resumed already)
    if (event.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (reason?.kind === 'interrupted') return event
    if (reason?.kind === 'max-tokens') return event
    if (reason?.kind === 'error' && errorPattern.test(JSON.stringify(reason.error ?? ''))) return event
    if (reason?.kind === 'completed') {
      // The final assistant text of THAT turn decides the fake-tool-call case;
      // scan back from the boundary until the turn's start.
      for (let j = i - 1; j >= 0 && events[j].type !== 'turn/start'; j -= 1) {
        if (events[j].type !== 'assistant/message') continue
        if (toolCallPattern.test(assistantVisibleText(events[j].data))) return event // fake tool-call stall
        break
      }
    }
    return null // clean completion or a non-transient failure: hands off to the user
  }
  return null
}

/**
 * Send the configured continue prompt to one session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - target Session.
 * @param {string} promptText - exact text to send.
 * @param {string} tag - unique requestId suffix (dedup identity).
 * @returns {Promise<void>}
 */
async function continueSession(ctx, sessionId, promptText, tag) {
  await ctx.sessionController.prompt(
    {
      requestId: `dsh-auto-continue-${sessionId}-${tag}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    },
    AbortSignal.timeout(15000),
  )
}

/**
 * Scan the whole corpus and continue every resume-worthy session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {{promptText: string, maxAgeMs: number, includeDelegated: boolean, errorPattern: RegExp, toolCallPattern: RegExp, log: object}} options - effective configuration plus the named logger.
 * @returns {Promise<void>}
 */
async function scan(ctx, { promptText, fakeCallPrompt, maxAgeMs, includeDelegated, errorPattern, toolCallPattern, log }) {
  const now = Date.now()
  const records = await ctx.sessionQuery.listSessions()
  let continued = 0
  for (const record of records) {
    const sessionId = record.header.id
    let observation
    try {
      // ponytail: reads the complete cold log per session at boot; fine at
      // local scale (hundreds of sessions). Upgrade path: a tail-window read.
      // Deliberately no "already live" skip: goal/job-driven resumes attach
      // the Agent around boot but may leave the closer as the tail with no
      // follow-up. The tail shape below is the only condition.
      observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      const closer = resumeCloser(observation.events, errorPattern, toolCallPattern)
      if (closer === null) continue
      if (now - closer.time > maxAgeMs) {
        log.info('skipping stale stuck session', { sessionId, ageHours: Math.round((now - closer.time) / 3600000) })
        continue
      }
      if (!includeDelegated && (record.header.delegationDepth ?? 0) > 0) {
        log.info('skipping delegated session', { sessionId })
        continue
      }
      // Fake-call stalls (closer "completed" with pair in text) get the direct
      // nudge so the model re-issues the call instead of just resuming.
      const text = closer.data?.reason?.kind === 'completed' ? fakeCallPrompt : promptText
      await continueSession(ctx, sessionId, text, `scan-${now}`)
      continued += 1
      log.info('continued stuck session', { sessionId, closerKind: closer.data?.reason?.kind })
    } catch (error) {
      // Archived sessions and model-unavailable sessions refuse the prompt;
      // ponytail: treat every rejection as a skip — the reason is logged.
      log.warn('could not continue session', { sessionId, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      observation?.[Symbol.dispose]?.()
    }
  }
  log.info('auto-continue scan finished', { continued, scanned: records.length })
}

/**
 * Plugin entry: boot scan plus a live error-retry listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object} [config] - raw patch config (no schema; values read leniently).
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger('dsh-auto-continue')
  const promptText = typeof config.promptText === 'string' && config.promptText.trim() !== '' ? config.promptText : 'continue'
  // Direct nudge for the fake-tool-call stall: naming the wrong-place call
  // lets the model correct itself instead of blindly continuing.
  const fakeCallPrompt = typeof config.fakeCallPrompt === 'string' && config.fakeCallPrompt.trim() !== '' ? config.fakeCallPrompt : "There's a literal <tool_call>…</tool_call> block in the chat. I think you sent the tool call to the wrong place — the chat instead of DSH. Please issue the real tool call now and continue."
  const maxAgeMs = numberOr(config.maxAgeHours, 72) * 3600000
  const includeDelegated = config.includeDelegated === true
  const delayMs = numberOr(config.delaySeconds, 5) * 1000
  const errorPattern = new RegExp(typeof config.resumeErrorPattern === 'string' && config.resumeErrorPattern.trim() !== '' ? config.resumeErrorPattern : '503|no reachable URL|every configured URL failed|engine stopped unexpectedly|exit code -15|context_length_exceeded|leaves no room to answer', 'i')
  const toolCallPattern = new RegExp(typeof config.toolCallPattern === 'string' && config.toolCallPattern.trim() !== '' ? config.toolCallPattern : '<tool_call>(?:(?!</?tool_call\\s*>)[\\s\\S])*?<[a-zA-Z_][\\s\\S]*?</tool_call>|<function_call>(?:(?!</?function_call\\s*>)[\\s\\S])*?<[a-zA-Z_][\\s\\S]*?</function_call>|<invoke\\b(?:(?!<invoke\\b|</invoke\\s*>)[\\s\\S])*?<[a-zA-Z_][\\s\\S]*?</invoke>', 'i')
  const errorRetryMs = numberOr(config.errorRetryDelaySeconds, 60) * 1000
  const maxErrorRetries = numberOr(config.maxErrorRetries, 3)
  ctx.effect(() => {
    const timer = setTimeout(() => {
      scan(ctx, { promptText, fakeCallPrompt, maxAgeMs, includeDelegated, errorPattern, toolCallPattern, log }).catch((error) => {
        log.error('auto-continue scan failed', { reason: error instanceof Error ? error.message : String(error) })
      })
    }, delayMs)
    return () => clearTimeout(timer)
  }, 'dsh-auto-continue boot scan')
  ctx.effect(() => {
    const retries = new Map() // ponytail: per-boot auto-continue budget for ALL live triggers; resets on restart, where the scan re-arms one more attempt.
    const fakeCallSeen = new Set() // sessions whose latest assistant text printed tool-call markup (fake call); cleared when the turn closes.
    const timers = new Set()
    ctx.on('session/event', (session, event) => {
      const sessionId = session.id
      if (!includeDelegated && (session.header?.delegationDepth ?? 0) > 0) return
      if (event.type === 'turn/start') {
        fakeCallSeen.delete(sessionId)
        return
      }
      if (event.type === 'assistant/message') {
        if (toolCallPattern.test(assistantVisibleText(event.data))) fakeCallSeen.add(sessionId)
        return
      }
      const reason = event.type === 'turn/end' ? event.data?.reason : undefined
      if (reason === undefined) return
      let trigger = null
      if (reason.kind === 'max-tokens') trigger = 'max-tokens'
      else if (reason.kind === 'error' && errorPattern.test(JSON.stringify(reason.error ?? ''))) trigger = 'error'
      else if (reason.kind === 'completed' && fakeCallSeen.delete(sessionId)) trigger = 'fake-call'
      if (trigger === null) return
      const used = retries.get(sessionId) ?? 0
      if (used >= maxErrorRetries) {
        log.warn('auto-continue budget exhausted', { sessionId, used, trigger })
        return
      }
      const attempt = used + 1
      retries.set(sessionId, attempt)
      const timer = setTimeout(() => {
        timers.delete(timer)
        // Re-check the tail before injecting: the user may have continued
        // already, or a later turn superseded the failed one.
        ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' }).then((observation) => {
          try {
            const closer = resumeCloser(observation.events, errorPattern, toolCallPattern)
            if (closer === null) return
            if (Date.now() - closer.time > maxAgeMs) return
            log.info('auto-continuing stalled turn', { sessionId, attempt, trigger })
            const text = closer.data?.reason?.kind === 'completed' ? fakeCallPrompt : promptText
            return continueSession(ctx, sessionId, text, `retry-${event.seq}-${attempt}`)
          } finally {
            observation?.[Symbol.dispose]?.()
          }
        }).catch((error) => {
          log.warn('auto-continue retry failed', { sessionId, reason: error instanceof Error ? error.message : String(error) })
        })
      }, errorRetryMs)
      timers.add(timer)
    })
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, 'dsh-auto-continue live turn-end watcher')
}
