/**
 * dsh-zoom-call — Host half.
 *
 * One session becomes a "zoom call": a cast of named personas (screenwriter,
 * director, storyboard artist, cinematographer, history scholar, ...) that the
 * human and the Lead agent can both call in as native experimental-Agent-Teams
 * teammates. Each cast member carries:
 *   - a real system prompt: a scoped `systemPrompt.section` attached to the
 *     teammate Agent (same mechanism the native persona/deployment prefix uses),
 *   - a mode template (how it behaves on the call),
 *   - optional permission preset and model selection (appended as durable
 *     session events, exactly like the subagent launch overrides do),
 *   - a color + emoji, consumed by the client to tint its chat bubbles through
 *     dsh-chat-bubbles' own `[data-dsh-chat-bubble]` + `--dcb-*` variables.
 *
 * Cast lives in the session workspace at `.zoom-call.cast.json` (edit by hand
 * or through the panel). Teammates are spawned through `ctx.agentTeams`
 * (experimental Agent Teams), so all roster/inbox/task behavior stays native.
 *
 * Safety: `agentTeams`, `webServer` and `agents` are reached through optional
 * `ctx.inject`, so a headless profile or a composition without Agent Teams
 * mounts the plugin without breaking boot — this is the documented defense
 * against a bad plugin bricking DSH startup.
 *
 * No bare `@deepseek-ai/*` imports: every service arrives by string injection,
 * so this linked plugin needs no npm dependencies at all.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-zoom-call'
export const inject = ['tools']

const CAST_FILE = '.zoom-call.cast.json'
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const ACTIVATION_TIMEOUT_MS = 300_000 // bounds only the spawn activation wait

/** Distinct palette slots; a member without a color takes one by position. */
export const PALETTE = ['#e05d7f', '#4f9de9', '#3ecf8e', '#f2a65a', '#b58ae8', '#e8584f', '#56c8d8', '#c3d268']

/** Standard system-prompt base: every cast member gets this, then its persona. */
export const STANDARD_BASE =
  'You are a named member of a Zoom-Call cast in this DSH session. A cast of specialist agents shares one production conversation. Stay in character for your role at all times. The human is the Executive Producer; the session Lead agent is the Second Executive Producer who runs the call.'

/** Standard mode template: how cast members interact on the call. */
export const STANDARD_MODE =
  'How you behave on this call:\n' +
  '- Speak only when the human, the Lead, or another cast member addresses you, or when your specialty changes the decision on the table.\n' +
  '- Keep replies short and high-signal: your judgement, not essays.\n' +
  '- When your answer belongs in the shared chat, send it to the Lead with send_message({ target: "lead", message: "..." }) — prefix it with your role name.\n' +
  '- Address other cast members by name; disagree openly, stay professional.\n' +
  '- Never impersonate another cast member or the Lead.'

/** Built-in starter cast so a fresh project opens with a usable crew. */
export const STARTER_CAST = [
  { name: 'screenwriter', display: 'Screenwriter', emoji: '✍️', systemPrompt: 'You own script structure, scenes, dialogue and coverage notes. Flag pacing and motivation problems bluntly, and offer punch-up alternatives.' },
  { name: 'film-director', display: 'Director', emoji: '🎬', systemPrompt: 'You own the overall vision: tone, performance, story beats and final cuts. Resolve conflicts between departments and give clear decisions.' },
  { name: 'storyboard-artist', display: 'Storyboard Artist', emoji: '🖍️', systemPrompt: 'You translate script and direction into shot-by-shot visual plans: framing, blocking, transitions. Describe boards concretely (shot size, angle, movement).' },
  { name: 'cinematographer', display: 'Cinematographer', emoji: '🎥', systemPrompt: 'You own camera, lensing, lighting and movement. Comment on shot feasibility, lens choice, lighting motivation and coverage.' },
  { name: 'history-scholar', display: 'History Scholar', emoji: '📜', systemPrompt: 'You check period accuracy: customs, technology, language, material culture and events. Flag anachronisms with sources and low-cost fixes.' },
]

/**
 * Fill one raw cast entry with the cascade standard → file defaults → member.
 * Empty strings mean "inherit"; they never clear an inherited value.
 * @param raw - the member object as written in the cast file.
 * @param defaults - the cast file's `defaults` block.
 * @param index - position, used to pick a palette color.
 * @returns normalized member record.
 */
export function normalizeMember(raw, defaults = {}, index = 0) {
  const pick = (key, standard = '') => {
    const mine = typeof raw?.[key] === 'string' ? raw[key].trim() : ''
    if (mine !== '') return mine
    const inherited = typeof defaults?.[key] === 'string' ? defaults[key].trim() : ''
    if (inherited !== '') return inherited
    return standard
  }
  const context = raw?.context === 'fork' ? 'fork' : 'fresh'
  return {
    name: typeof raw?.name === 'string' ? raw.name.trim().toLowerCase() : '',
    display: pick('display', ''),
    emoji: pick('emoji', '🎭'),
    color: pick('color', PALETTE[index % PALETTE.length]),
    systemPrompt: pick('systemPrompt', ''),
    modeTemplate: pick('modeTemplate', STANDARD_MODE),
    kickoff: pick('kickoff', ''),
    context,
    permission: pick('permission', ''),
    model: pick('model', ''),
  }
}

/** Full persona text: standard base + role prompt + mode template. */
export function personaText(member) {
  return [STANDARD_BASE, member.systemPrompt, member.modeTemplate].filter((block) => block !== '').join('\n\n')
}

/** The teammate's first message: the same persona plus the call-in confirm ask. */
export function kickoffText(member) {
  return personaText(member) + '\n\nCall-in brief: you have just been added to the session cast. Confirm your role in one sentence by replying to the Lead (send_message target "lead", prefix your role name). ' + member.kickoff
}

/** Parse `provider/model[/effort]` into a durable model/selection payload. */
export function parseModel(value) {
  if (typeof value !== 'string') return undefined
  const parts = value.split('/').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length < 2) return undefined
  if (parts.length === 2) return { provider: parts[0], model: parts[1] }
  return { provider: parts[0], model: parts[1], reasoningEffort: parts[2] }
}

/** Validate and normalize one decoded cast file; throws with a clear reason. */
export function parseCastDoc(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('cast file must be a JSON object')
  const cast = Array.isArray(doc.cast) ? doc.cast : []
  const members = cast.map((raw, index) => normalizeMember(raw, doc.defaults ?? {}, index))
  for (const member of members) {
    if (!NAME_RE.test(member.name)) throw new Error(`cast member name "${member.name}" must be lower-kebab-case, 1-32 chars, starting with a letter`)
  }
  const roster = doc.roster !== null && typeof doc.roster === 'object' && !Array.isArray(doc.roster) ? doc.roster : {}
  return { version: 1, defaults: doc.defaults ?? {}, cast: members, roster }
}

/** Read the cast file for one workspace; a missing file seeds the starter cast. */
async function readCast(cwd) {
  const path = join(cwd, CAST_FILE)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const seeded = { version: 1, defaults: {}, cast: STARTER_CAST.map((raw) => normalizeMember(raw, {}, 0)), roster: {} }
    await writeCast(cwd, seeded)
    return seeded
  }
  return parseCastDoc(JSON.parse(text))
}

/** Write the cast file atomically (temp + rename), keeping the workspace tidy. */
async function writeCast(cwd, doc) {
  const path = join(cwd, CAST_FILE)
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify({ version: doc.version ?? 1, defaults: doc.defaults ?? {}, cast: doc.cast, roster: doc.roster ?? {} }, null, 2) + '\n'
  await writeFile(path + '.tmp', body, 'utf8')
  await rename(path + '.tmp', path)
}

export async function apply(ctx, config = {}) {
  // Experimental Agent Teams is opt-in; when it is not mounted the plugin stays
  // inert instead of breaking the composition (never brick the boot).
  let team
  let agentsService
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentTeams'], (scoped) => { team = scoped.agentTeams })
    ctx.inject(['agents'], (scoped) => { agentsService = scoped.agents })
  }

  // Live per-process attach bookkeeping: sessionId -> cast member name, plus
  // one done-set per half of the attach (prompt section vs mode events).
  const rosterBySession = new Map()
  const sectionDone = new Set()
  const modeDone = new Set()

  function rememberRoster(doc) {
    for (const [sessionId, memberName] of Object.entries(doc.roster ?? {})) {
      if (typeof sessionId === 'string' && typeof memberName === 'string') rosterBySession.set(sessionId, memberName)
    }
  }

  /** Attach one cast member's persona as a scoped system-prompt section. */
  function attachSection(agent, member) {
    if (agent === undefined || member === undefined || sectionDone.has(agent.id)) return
    const promptService = agent.ctx?.systemPrompt
    if (promptService === undefined || typeof promptService.section !== 'function') return
    const order = typeof promptService.getSectionOrder === 'function' ? (promptService.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') ?? 5) : 5
    promptService.section({ name: 'zoom-call:persona', order, text: personaText(member) })
    sectionDone.add(agent.id)
  }

  /**
   * Apply permission preset and model selection as durable session events (the
   * same events the native subagent launch overrides append). Runs inside the
   * Agent's idle maintenance phase; a busy Agent stays unmarked so the
   * agent/status listener retries at the next idle edge.
   */
  function applyMode(agent, member) {
    if (agent === undefined || member === undefined || modeDone.has(agent.id)) return
    if (member.permission === '' && member.model === '') {
      modeDone.add(agent.id)
      return
    }
    const selection = member.model === '' ? undefined : parseModel(member.model)
    if (typeof agent.runMaintenance !== 'function') return
    const claimed = agent.runMaintenance(() => {
      if (member.permission !== '') agent.session.append('permission/preset', { preset: member.permission })
      if (selection !== undefined) agent.session.append('model/selection', selection)
    })
    // runMaintenance rejects while the Agent is busy; retry at the idle edge.
    if (typeof claimed?.then === 'function') claimed.then(() => modeDone.add(agent.id), () => {})
    else modeDone.add(agent.id)
  }

  /** When a known cast teammate is live, (re)attach the halves it still lacks. */
  ctx.on('agent/status', ({ agent }) => {
    if (agent?.status !== 'idle') return
    const memberName = rosterBySession.get(agent.id)
    if (memberName === undefined) return
    if (sectionDone.has(agent.id) && modeDone.has(agent.id)) return
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    readCast(cwd).then((doc) => {
      rememberRoster(doc)
      const member = doc.cast.find((entry) => entry.name === memberName)
      if (member === undefined) return
      attachSection(agent, member)
      applyMode(agent, member)
    }, () => {})
  })

  function leadAgent(sessionId) {
    if (agentsService === undefined) throw new Error('agents service is not mounted in this composition')
    const agent = agentsService.get?.(sessionId)
    if (agent === undefined) throw new Error('this session has no live Agent right now')
    return agent
  }

  async function castFor(agent) {
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') throw new Error('session has no workspace to read the cast from')
    const doc = await readCast(cwd)
    rememberRoster(doc)
    return { doc, cwd }
  }

  /** Spawn (or resume-check) one cast member as a teammate, then attach it. */
  async function callIn(agent, member) {
    if (team === undefined) throw new Error('Agent Teams is not mounted in this composition; enable @deepseek-ai/dsh-experimental-agent-team-profile')
    if (!NAME_RE.test(member.name)) throw new Error(`cast member name "${member.name}" is not lower-kebab-case`)
    const current = team.listMembers(agent)
    const existing = current.members?.find?.((row) => row.name === member.name) ?? (Array.isArray(current) ? current.find((row) => row.name === member.name) : undefined)
    if (existing !== undefined) return { member: existing, resumed: true }
    const view = await team.spawnTeammate(agent, {
      name: member.name,
      description: (member.display || member.name).slice(0, 200),
      prompt: [{ type: 'text', text: kickoffText(member) }],
      context: member.context,
      provider: member.context === 'fork' ? 'fork' : 'spawn',
      signal: AbortSignal.timeout(ACTIVATION_TIMEOUT_MS),
    })
    const spawned = view.member ?? view
    attachSection(agentsService?.get?.(spawned.id), member)
    applyMode(agentsService?.get?.(spawned.id), member)
    // Persist the session id so a later DSH restart can re-attach the persona.
    const { doc, cwd } = await castFor(agent)
    doc.roster[spawned.id] = spawned.name ?? member.name
    await writeCast(cwd, doc)
    return { member: spawned, resumed: false }
  }

  function rosterRows(agent) {
    if (team === undefined) return []
    const current = team.listMembers(agent)
    const list = current.members ?? (Array.isArray(current) ? current : [])
    return list.map((row) => ({ name: row.name, sessionId: row.id, phase: row.status ?? row.phase ?? 'unknown' }))
  }

  // ---------- Model-facing tool (the Second Executive Producer) ----------
  const zoomTool = {
    name: 'zoom_call',
    description:
      'Run the session Zoom-Call cast. The cast (personas with system prompts, mode templates and colors) lives in .zoom-call.cast.json in the workspace — edit it or ask the human to. ' +
      'actions: list = every configured member and whether it is called in; assemble = call one member in by name (target) or all not-yet-present members (all=true); ' +
      'say = send a message to a called-in member (target, message); status = live team roster; dismiss = interrupt a member turn (target). ' +
      'Call people IN — do not hand-roll generic teammates for roles the cast already defines.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'assemble', 'say', 'status', 'dismiss'] },
      target: { type: 'string', description: 'Cast member name (lower-kebab).' },
      message: { type: 'string', description: 'Text for say.' },
      all: { type: 'string', description: '"true" to assemble every missing cast member.' },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) return { ok: false, error: 'a live session Agent is required' }
      if (team === undefined) return { ok: false, error: 'Agent Teams is not mounted; enable @deepseek-ai/dsh-experimental-agent-team-profile' }
      try {
        if (args.action === 'list') {
          const { doc } = await castFor(agent)
          const rows = rosterRows(agent)
          const summary = doc.cast.map((m) => ({ name: m.name, display: m.display || m.name, emoji: m.emoji, color: m.color, context: m.context, permission: m.permission, model: m.model, calledIn: rows.some((row) => row.name === m.name) }))
          return { ok: true, cast: summary }
        }
        if (args.action === 'status') return { ok: true, roster: rosterRows(agent) }
        if (args.action === 'assemble') {
          const { doc } = await castFor(agent)
          const wanted = args.all === 'true' ? doc.cast : doc.cast.filter((m) => m.name === args.target)
          if (wanted.length === 0) return { ok: false, error: `no cast member "${args.target ?? ''}" — configure it in ${CAST_FILE} first` }
          const results = []
          for (const member of wanted) {
            try {
              const { member: row, resumed } = await callIn(agent, member)
              results.push({ name: member.name, ok: true, resumed, sessionId: row.id })
            } catch (error) {
              results.push({ name: member.name, ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          }
          return { ok: results.some((r) => r.ok), results }
        }
        if (args.action === 'say') {
          if (typeof args.message !== 'string' || args.message === '') return { ok: false, error: 'say needs message' }
          const view = await team.sendMessage(agent, { target: args.target, content: [{ type: 'text', text: args.message }], signal: AbortSignal.timeout(30_000) })
          return { ok: true, messageId: view.messageId }
        }
        if (args.action === 'dismiss') {
          const view = team.interrupt(agent, args.target)
          return { ok: true, view }
        }
        return { ok: false, error: 'unknown action' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
  ctx.effect(() => ctx.tools.register(zoomTool), 'zoom-call cast tool')

  // ---------- Panel HTTP surface ----------
  const sendJson = (res, code, value) => {
    const body = JSON.stringify(value)
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(body)
  }
  async function readBody(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      total += chunk.length
      if (total > 8 * 1024 * 1024) throw new Error('request body exceeds 8 MiB')
    }
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    try {
      const sessionId = url.searchParams.get('session_id') ?? undefined
      let body = {}
      if (req.method === 'POST') body = await readBody(req)
      const sid = body.session_id ?? sessionId
      if (typeof sid !== 'string' || sid === '') {
        sendJson(res, 400, { error: 'session_id is required' })
        return
      }
      const agent = leadAgent(sid)
      const path = url.pathname
      if (path === '/zoom-call/api/cast') {
        const { doc } = await castFor(agent)
        const permissionPresets = ctx.get?.('permissionPresets')
        // Tell the client whether THIS conversation belongs to a cast member,
        // so its own assistant bubbles can take the member color.
        const selfName = rosterBySession.get(agent.id)
        sendJson(res, 200, {
          cast: doc.cast,
          defaults: doc.defaults,
          roster: rosterRows(agent),
          self: selfName ?? null,
          permissionOptions: permissionPresets?.catalog?.() ?? [],
          standard: { base: STANDARD_BASE, mode: STANDARD_MODE, file: CAST_FILE },
        })
        return
      }
      if (req.method === 'POST' && path === '/zoom-call/api/save') {
        const doc = parseCastDoc(body.doc ?? {})
        // Keep roster entries for sessions still on the team even if the human
        // re-edited the cast list mid-call.
        doc.roster = { ...(await castFor(agent)).doc.roster, ...doc.roster }
        await writeCast(agent.session.header.cwd, doc)
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && path === '/zoom-call/api/assemble') {
        const { doc } = await castFor(agent)
        const wanted = body.all === true ? doc.cast : doc.cast.filter((m) => m.name === body.name)
        const results = []
        for (const member of wanted) {
          try {
            const { member: row, resumed } = await callIn(agent, member)
            results.push({ name: member.name, ok: true, resumed })
          } catch (error) {
            results.push({ name: member.name, ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        sendJson(res, 200, { ok: results.every((r) => r.ok || r.error === undefined), results })
        return
      }
      if (req.method === 'POST' && (path === '/zoom-call/api/say' || path === '/zoom-call/api/dismiss' || path === '/zoom-call/api/assemble')) {
        if (team === undefined) {
          sendJson(res, 500, { error: 'Agent Teams is not mounted in this composition' })
          return
        }
      }
      if (req.method === 'POST' && path === '/zoom-call/api/say') {
        const view = await team.sendMessage(agent, { target: body.name, content: [{ type: 'text', text: '🎙️ From the Executive Producer (human): ' + String(body.text ?? '') }], signal: AbortSignal.timeout(30_000) })
        sendJson(res, 200, { ok: true, messageId: view.messageId })
        return
      }
      if (req.method === 'POST' && path === '/zoom-call/api/dismiss') {
        sendJson(res, 200, { ok: true, view: team.interrupt(agent, body.name) })
        return
      }
      sendJson(res, 404, { error: 'unknown zoom-call endpoint' })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scoped) => {
      if (scoped.webServer === undefined) return
      const dispose = scoped.webServer.register({ kind: 'prefix', path: '/zoom-call', handler: handle })
      scoped.effect(() => dispose, 'zoom-call panel api')
    })
  }
}
