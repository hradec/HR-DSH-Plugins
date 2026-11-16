import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { apply } from './index.js';

// Exercise the public plugin entry with isolated files, no live endpoint or
// profile writes. The fake editor behaves like the native config editor.
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-effort-test-'));
  const cacheFile = join(directory, 'cache.json');
  let now = 1_792_911_308_250;
  let config = {
    providers: {
      router: {
        api: 'openai-responses',
        baseURL: 'https://endpoint.invalid/v1',
        reasoning: 'high',
        defaultInput: ['text', 'image'],
        models: [{ id: 'old', name: 'Old model' }],
      },
    },
  };
  let status = 200;
  let edits = 0;
  let editError;
  const requests = [];
  const warnings = [];
  const disposers = [];
  const listing = [
    { id: 'old', supported_reasoning_levels: ['low', 'high', 'max'] },
    { id: 'new', supported_reasoning_levels: ['none', 'high', 'xhigh', 'ultra'] },
    { id: 'silent' },
    { id: 'off-only', supported_reasoning_levels: ['none'] },
  ];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return status === 200 ? Response.json({ data: listing }) : new Response('', { status });
  });
  const entry = { options: { id: 'llm-pi-ai' } };
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, override: config }],
    documentPath: join(directory, 'cordis.patch.yml'),
    async edit(_entry, update) {
      edits += 1;
      if (editError !== undefined) throw editError;
      config = update(config);
    },
  };
  function mount(options = {}) {
    class Llm {
      async listModels(provider) {
        return structuredClone(config.providers[provider]?.models ?? []);
      }
    }
    const llm = new Llm();
    apply({
      llm,
      get: (key) => key === 'configEditor' ? editor : undefined,
      logger: { info() {}, warn: (...args) => warnings.push(args) },
      inject() {},
      effect(register) { disposers.push(register()); },
    }, { cacheFile, statusFile: false, ...options });
    return llm;
  }
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    // Verify this is our generated temp directory before deleting anything.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dsh-effort-test-'));
    rmSync(directory, { recursive: true });
  });
  return {
    cacheFile, editor, requests, warnings, mount,
    get profile() { return config.providers.router; },
    get edits() { return edits; },
    cache: () => JSON.parse(readFileSync(cacheFile, 'utf8')),
    advance: (ms) => { now += ms; },
    failFetch: (code) => { status = code; },
    failEdit: (error) => { editError = error; },
  };
}

test('first read populates efforts; cache and unrelated settings survive repeated reads', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  const models = await llm.listModels('router');
  assert.deepEqual(models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
  const cached = f.cache();
  assert.match(cached.routes.router.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(f.profile.reasoning, 'high');
  assert.deepEqual(f.profile.defaultInput, ['text', 'image']);
  await llm.listModels('router');
  await llm.listModels('router');
  assert.equal(f.requests.length, 1);
  assert.equal(f.edits, 1);
  assert.deepEqual(f.cache(), cached);
});

test('default cache expires at five minutes, not one week', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  f.advance(299_999);
  await llm.listModels('router');
  assert.equal(f.requests.length, 1);
  f.advance(1);
  await llm.listModels('router');
  assert.equal(f.requests.length, 2);
  assert.equal(f.edits, 1);
});

test('adding a model bypasses a fresh cache and subsequent reads remain cached', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  f.profile.models.push({ id: 'new', name: 'New model' });
  const models = await llm.listModels('router');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(models[1].reasoningEfforts, { off: 'none', high: 'high', xhigh: 'xhigh' });
  assert.equal(f.profile.reasoning, 'high');
  await llm.listModels('router');
  assert.equal(f.requests.length, 2, 'post-sync declarations must not invalidate themselves');
});

test('refreshing the same model IDs without efforts repairs the declarations immediately', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  delete f.profile.models[0].reasoningEfforts;
  const models = await llm.listModels('router');
  assert.equal(f.requests.length, 2);
  assert.equal(models[0].reasoningEfforts.high, 'high');
  await llm.listModels('router');
  assert.equal(f.requests.length, 2);
});

test('successful cache survives a new plugin instance but still detects new models', async (t) => {
  const f = setup(t);
  await f.mount().listModels('router');
  const cached = f.cache();
  const reloaded = f.mount();
  await reloaded.listModels('router');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.cache(), cached);
  f.profile.models.push({ id: 'new' });
  await reloaded.listModels('router');
  assert.equal(f.requests.length, 2);
  assert.equal(f.profile.models[1].reasoningEfforts.xhigh, 'xhigh');
});

test('endpoint URL and protocol changes invalidate a fresh cache', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  f.profile.baseURL = 'https://replacement.invalid/v1';
  await llm.listModels('router');
  assert.equal(f.requests[1], 'https://replacement.invalid/v1/models');
  f.profile.api = 'openai-completions';
  await llm.listModels('router');
  assert.equal(f.requests.length, 3);
});

test('model names, order, effort-key order and token limits do not invalidate the cache', async (t) => {
  const f = setup(t);
  f.profile.models.push({ id: 'new' });
  const llm = f.mount();
  await llm.listModels('router');
  const old = f.profile.models[0];
  old.name = 'Renamed model';
  old.contextWindow = 500_000;
  old.reasoningEfforts = { max: 'max', high: 'high', low: 'low' };
  f.profile.models.reverse();
  f.profile.defaultInput.reverse();
  await llm.listModels('router');
  assert.equal(f.requests.length, 1);
});

test('legacy timestamp-only cache refreshes once and migrates to fingerprint records', async (t) => {
  const f = setup(t);
  writeFileSync(f.cacheFile, JSON.stringify({ routes: { router: { fetchedAt: Date.now() } } }));
  const llm = f.mount();
  await llm.listModels('router');
  await llm.listModels('router');
  assert.equal(f.requests.length, 1);
  assert.match(f.cache().routes.router.fingerprint, /^[0-9a-f]{64}$/);
});

test('failed refresh preserves old efforts/cache and retries on the next read', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  const cached = f.cache();
  f.profile.models.push({ id: 'new' });
  f.failFetch(503);
  let models = await llm.listModels('router');
  assert.equal(models[0].reasoningEfforts.high, 'high');
  assert.equal(models[1].reasoningEfforts, undefined);
  assert.deepEqual(f.cache(), cached);
  assert.equal(f.warnings.length, 1);
  f.failFetch(200);
  models = await llm.listModels('router');
  assert.equal(f.requests.length, 3);
  assert.equal(models[1].reasoningEfforts.high, 'high');
});

test('failed config writes do not mark new efforts as cached', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  const cached = f.cache();
  f.profile.models.push({ id: 'new' });
  f.failEdit(new Error('configuration write refused'));
  await llm.listModels('router');
  assert.deepEqual(f.cache(), cached);
  f.failEdit(undefined);
  await llm.listModels('router');
  assert.equal(f.requests.length, 3);
  assert.equal(f.profile.models[1].reasoningEfforts.high, 'high');
});

test('concurrent catalog reads share a fetch and write', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  const models = await Promise.all([
    llm.listModels('router'), llm.listModels('router'), llm.listModels('router'),
  ]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.edits, 1);
  assert.ok(models.every((value) => value[0].reasoningEfforts.high === 'high'));
});

test('models with no published efforts remain untouched and do not cause fetch loops', async (t) => {
  const f = setup(t);
  f.profile.models.push({ id: 'silent' }, { id: 'off-only' });
  const llm = f.mount();
  await llm.listModels('router');
  await llm.listModels('router');
  assert.equal(f.profile.models[1].reasoningEfforts, undefined);
  assert.equal(f.profile.models[2].reasoningEfforts, undefined);
  assert.equal(f.requests.length, 1);
});

test('removed image defaults are restored while the High default stays intact', async (t) => {
  const f = setup(t);
  const llm = f.mount();
  await llm.listModels('router');
  f.profile.defaultInput = ['text'];
  await llm.listModels('router');
  assert.deepEqual(f.profile.defaultInput, ['text', 'image']);
  assert.equal(f.profile.reasoning, 'high');
  await llm.listModels('router');
  assert.equal(f.requests.length, 2);
});

test('unmanaged routes do not fetch or alter their models', async (t) => {
  const f = setup(t);
  const llm = f.mount({ routes: ['another-provider'] });
  const models = await llm.listModels('router');
  assert.equal(models[0].reasoningEfforts, undefined);
  assert.equal(f.requests.length, 0);
  assert.equal(f.edits, 0);
});
