import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

process.env.DSH_SESSION_AGENT_PRESET_ENTRY ??= '/BACKUP/home/rhradec/.dsh/runtime/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const { changeSessionPreset } = await import('./index.js')
const clientSource = await readFile(new URL('./client.js', import.meta.url), 'utf8')
const packageManifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

function setup({ status = 'idle', resolver = async (id) => ({ id }), registryPresent = true } = {}) {
  let current = 'standard'
  const events = []
  let recompositions = 0
  const agent = {
    id: 'session-test',
    status,
    ctx: {},
    session: { append: (type, data) => events.push({ type, data }) },
    runMaintenance: (task) => {
      if (agent.status !== 'idle') throw new Error('Agent is running')
      return task(new AbortController().signal)
    },
  }
  const ctx = {
    agents: { get: (id) => id === agent.id ? agent : undefined },
    agentPresets: {
      resolve: resolver,
      composedPreset: () => current,
      recompose: async (_ctx, id) => { current = id; recompositions += 1; return { id } },
    },
  }
  if (!registryPresent) delete ctx.agentPresets
  return { ctx, agent, events, get current() { return current }, get recompositions() { return recompositions } }
}

test('declares the Host connection required to populate and operate the dropdown', () => {
  assert.ok(packageManifest.dsh.client.inject.includes('connection'))
  assert.match(clientSource, /inject: \['slots', 'connection'\]/)
})

test('keeps the shipped mode label visible when the replacement picker is absent', () => {
  assert.match(clientSource, /body:has\(\.dsap-seat\) \.SVAs4q_label\{display:none!important\}/)
  assert.doesNotMatch(clientSource, /^\.SVAs4q_label\{display:none!important\}/m)
})

test('switches an idle live Session and appends its durable preset event', async () => {
  const state = setup()
  const result = await changeSessionPreset(state.ctx, 'session-test', 'director')
  assert.deepEqual(result, { sessionId: 'session-test', agentPreset: 'director' })
  assert.equal(state.current, 'director')
  assert.equal(state.recompositions, 1)
  assert.deepEqual(state.events, [{ type: 'agent-preset/selected', data: { agentPreset: 'director' } }])
})

test('refuses an active Agent before any composition or log change', async () => {
  const state = setup({ status: 'running' })
  await assert.rejects(changeSessionPreset(state.ctx, 'session-test', 'director'), (error) => error.code === 'session-agent-preset/session-active')
  assert.equal(state.recompositions, 0)
  assert.deepEqual(state.events, [])
})

test('refuses a missing live Agent', async () => {
  const state = setup()
  await assert.rejects(changeSessionPreset(state.ctx, 'missing', 'director'), (error) => error.code === 'session-agent-preset/session-not-found')
})

test('refuses a preset that cannot be resolved', async () => {
  const state = setup({ resolver: async () => { throw new Error('preset missing') } })
  await assert.rejects(changeSessionPreset(state.ctx, 'session-test', 'missing'), (error) => error.code === 'session-agent-preset/preset-invalid')
  assert.equal(state.recompositions, 0)
  assert.deepEqual(state.events, [])
})

test('refuses a preset whose composition failed to load', async () => {
  const state = setup({ resolver: async (id) => ({ id, broken: 'plugin failed to load' }) })
  await assert.rejects(changeSessionPreset(state.ctx, 'session-test', 'unavailable'), (error) => error.code === 'session-agent-preset/preset-invalid')
  assert.equal(state.recompositions, 0)
  assert.deepEqual(state.events, [])
})

test('refuses if the Agent stops being idle before maintenance starts', async () => {
  const state = setup()
  state.agent.runMaintenance = (task) => {
    state.agent.status = 'running'
    return task(new AbortController().signal)
  }
  await assert.rejects(changeSessionPreset(state.ctx, 'session-test', 'director'), (error) => error.code === 'session-agent-preset/session-active')
  assert.equal(state.recompositions, 0)
  assert.deepEqual(state.events, [])
})

test('rejects malformed target fields', async () => {
  const state = setup()
  await assert.rejects(changeSessionPreset(state.ctx, '', 'director'), (error) => error.code === 'session-agent-preset/bad-request')
  await assert.rejects(changeSessionPreset(state.ctx, 'session-test', ''), (error) => error.code === 'session-agent-preset/bad-request')
})
