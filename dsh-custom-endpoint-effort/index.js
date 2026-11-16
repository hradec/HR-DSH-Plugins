/**
 * custom-endpoint-effort — keep `llm-pi-ai`'s per-model `reasoningEfforts` in
 * sync with what each custom endpoint publishes in its own model listing.
 *
 * Hand-declared pi-ai routes replace the installed catalog, so a model without
 * `reasoningEfforts` is reported as non-reasoning and the composer offers no
 * effort menu. OpenAI-compatible gateways already list that capability; this
 * plugin reads it and writes the matching levels back through the profile's
 * config editor, after which selection behaves exactly like DeepSeek models.
 *
 * The sync is cached for five minutes, with the successful fetch time and
 * endpoint/model fingerprint persisted across Host restarts. Added models or
 * removed effort declarations invalidate the cache immediately. The client
 * half invalidates the catalog when the picker opens; unchanged routes reuse
 * this cache until the next catalog read after expiry.
 *
 * Recognised listing fields, first match wins:
 *   supported_reasoning_levels (objects with `effort`, or plain strings)
 *   reasoning_supported_efforts | supported_efforts | reasoning_efforts
 *
 * Safety: a model the endpoint does not list, or one whose endpoint says
 * nothing about reasoning, is left untouched. Existing declarations are never
 * erased.
 *
 * The same sync declares `defaultInput: [text, image]` on the managed route so
 * its hand-declared models accept image attachments. DSH and pi-ai only define
 * `text` and `image` modalities; video and audio cannot be declared.
 *
 * @module dsh-custom-endpoint-effort
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'custom-endpoint-effort';
export const inject = ['configEditor', 'llm'];

/** Every level the pi-ai adapter can name, in escalation order. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Endpoint spellings that mean the same DSH level. */
const ALIASES = new Map([
  ['none', 'off'],
  ['off', 'off'],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
]);

/** Listing fields that may publish selectable levels. */
const EFFORT_FIELDS = [
  'supported_reasoning_levels',
  'reasoning_supported_efforts',
  'supported_efforts',
  'reasoning_efforts',
];

/** Protocols whose model listing this plugin can read. */
const LISTABLE = new Set([
  'openai-completions',
  'openai-responses',
  'openai-responses-lite',
  'anthropic-messages',
]);

/**
 * Input modalities to force on the managed route. DSH and pi-ai can only name
 * text and image; there is no video or audio modality to declare.
 */
const IMAGE_INPUT = ['text', 'image'];

const DEFAULTS = {
  entryId: 'llm-pi-ai',
  routes: [],
  timeoutMs: 15000,
  refreshMs: 5 * 60 * 1000,
  cacheFile: '',
  statusFile: '',
};

/**
 * Normalise plugin config.
 * @param {unknown} raw - config from the profile patch.
 * @returns {typeof DEFAULTS} resolved options.
 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const options = { ...DEFAULTS };
  if (typeof input.entryId === 'string' && input.entryId.length > 0) options.entryId = input.entryId;
  if (Array.isArray(input.routes) && input.routes.every((route) => typeof route === 'string')) options.routes = [...input.routes];
  for (const key of ['timeoutMs', 'refreshMs']) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0) options[key] = input[key];
  }
  if (typeof input.statusFile === 'string' || input.statusFile === false) options.statusFile = input.statusFile;
  if (typeof input.cacheFile === 'string' || input.cacheFile === false) options.cacheFile = input.cacheFile;
  return options;
}

/** Hash only the non-secret endpoint and capability inputs relevant to sync. */
function profileFingerprint(profile) {
  // ponytail: a small O(n log n) scan; names, ordering and token limits do not
  // invalidate efforts. Server-only changes are discovered at cache expiry.
  const models = profile.models
    .filter((model) => typeof model?.id === 'string')
    .map((model) => [model.id, model.reasoningEfforts && typeof model.reasoningEfforts === 'object'
      ? Object.entries(model.reasoningEfforts).sort(([left], [right]) => left.localeCompare(right))
      : model.reasoningEfforts ?? null])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify([
    profile.api ?? 'openai-completions',
    profile.baseURL.replace(/\/+$/, ''),
    [...(profile.defaultInput ?? [])].sort(),
    models,
  ])).digest('hex');
}

/**
 * Persist successful sync timestamps and fingerprints, not credentials.
 * @param {unknown} rawConfig - plugin config.
 * @returns {{get: (route: string) => object | undefined, set: (route: string, record: object) => void}}
 */
function createCache(rawConfig) {
  const requested = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig.cacheFile : undefined;
  const noop = { get: () => undefined, set: () => {} };
  if (requested === false) return noop;
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  const file = typeof requested === 'string' && requested.length > 0 ? requested : join(home, 'custom-endpoint-effort.cache.json');
  const read = () => {
    try {
      const body = JSON.parse(readFileSync(file, 'utf8'));
      return body !== null && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  };
  return {
    get(route) {
      const record = read().routes?.[route];
      // Timestamp-only caches predate model-change detection: refresh once.
      return typeof record?.fetchedAt === 'number' && Number.isFinite(record.fetchedAt)
        && typeof record.fingerprint === 'string' ? record : undefined;
    },
    set(route, record) {
      try {
        const body = read();
        const routes = body.routes !== null && typeof body.routes === 'object' ? body.routes : {};
        routes[route] = record;
        writeFileSync(file, `${JSON.stringify({ ...body, routes }, null, 2)}\n`, 'utf8');
      } catch {
        /* a lost cache only costs one extra fetch */
      }
    },
  };
}

/**
 * One model listing entry's published effort names.
 * @param {unknown} entry - one entry of the endpoint's model listing.
 * @returns {string[] | undefined} published names, or undefined when silent.
 */
function publishedEfforts(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  for (const field of EFFORT_FIELDS) {
    const value = entry[field];
    if (!Array.isArray(value)) continue;
    const names = [];
    for (const item of value) {
      if (typeof item === 'string') names.push(item);
      else if (item !== null && typeof item === 'object') {
        if (typeof item.effort === 'string') names.push(item.effort);
        else if (typeof item.level === 'string') names.push(item.level);
      }
    }
    return names;
  }
  return undefined;
}

/**
 * Translate published endpoint names into a pi-ai `reasoningEfforts` map.
 * @param {string[] | undefined} names - published names.
 * @returns {Record<string, string> | undefined} level -> wire value, or
 *   undefined when the endpoint states nothing usable (leave the model alone).
 */
function toEfforts(names) {
  if (names === undefined) return undefined;
  const wire = new Map();
  for (const name of names) {
    const level = ALIASES.get(name);
    if (level === undefined) continue;
    if (!wire.has(level)) wire.set(level, name);
  }
  // `off` alone is not a valid declaration: the adapter requires a level
  // beyond off, and omitting the key already means the provider default.
  if (wire.size === 0 || (wire.size === 1 && wire.has('off'))) return undefined;
  const efforts = {};
  for (const level of LEVELS) if (wire.has(level)) efforts[level] = wire.get(level);
  return efforts;
}

/**
 * Compare two effort declarations, ignoring key order.
 * @param {unknown} left - current declaration.
 * @param {Record<string, string>} right - desired declaration.
 * @returns {boolean}
 */
function sameEfforts(left, right) {
  if (left === null || typeof left !== 'object' || Array.isArray(left)) return false;
  const leftLevels = LEVELS.filter((level) => Object.hasOwn(left, level));
  const rightLevels = LEVELS.filter((level) => Object.hasOwn(right, level));
  if (leftLevels.length !== rightLevels.length) return false;
  return leftLevels.every((level, index) => level === rightLevels[index] && left[level] === right[level]);
}

/**
 * Read the endpoint's model listing.
 * @param {any} ctx - plugin context, for the credentials service.
 * @param {any} profile - one pi-ai route profile.
 * @param {number} timeoutMs - per-request timeout.
 * @returns {Promise<Array<any>>} listing entries.
 */
async function fetchListing(ctx, profile, timeoutMs) {
  const base = String(profile.baseURL).replace(/\/+$/, '');
  const headers = new Headers(profile.headers ?? {});
  headers.set('accept', 'application/json');
  if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) {
    const credentials = ctx.get('credentials');
    const hit = credentials === undefined ? undefined : await credentials.resolve(profile.apiKeyEnv);
    const key = hit?.value ?? process.env[profile.apiKeyEnv];
    if (key !== undefined && key.length > 0) headers.set('authorization', `Bearer ${key}`);
  }
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${base}/models answered ${response.status}`);
  const body = await response.json();
  const container = body?.data ?? body?.models;
  if (Array.isArray(container)) return container;
  if (container !== null && typeof container === 'object') {
    return Object.entries(container).map(([id, value]) => (value !== null && typeof value === 'object' ? { id, ...value } : { id }));
  }
  return [];
}

/** Status document writer; never worth failing a sync over. */
function createStatus(rawConfig) {
  const requested = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig.statusFile : undefined;
  if (requested === false) return () => {};
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  const file = typeof requested === 'string' && requested.length > 0 ? requested : join(home, 'custom-endpoint-effort.status.json');
  return (patch) => {
    try {
      let previous = {};
      try {
        previous = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        previous = {};
      }
      writeFileSync(file, `${JSON.stringify({ ...previous, ...patch, statusFile: file, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    } catch {
      /* diagnostics must not break a selection attempt */
    }
  };
}

/**
 * Plan line edits that add or replace `reasoningEfforts` on the configured
 * models of one profile row. Line-based on purpose: the profile patch belongs
 * to its author, so comments, `!!js` expressions and untouched fields stay
 * byte-identical.
 * @param {string[]} lines - profile patch lines, without terminators.
 * @param {Map<string, Map<string, Record<string, string>>>} planned - route -> model id -> efforts.
 * @param {string} entryId - profile row to edit.
 * @returns {{lines: string[], changed: boolean}}
 */
function planPatchEdits(lines, planned, entryId, withImageInput = false) {
  const rowStart = lines.findIndex((line) => line.trim() === `- id: ${entryId}`);
  if (rowStart === -1) return { lines, changed: false };
  let rowEnd = lines.findIndex((line, index) => index > rowStart && /^- id: /.test(line));
  if (rowEnd === -1) rowEnd = lines.length;

  const edits = [];
  for (const [route] of planned) {
    const routeIndex = lines.findIndex((line, index) => {
      if (index <= rowStart || index >= rowEnd) return false;
      const match = /^(\s*)([^\s:#]+):\s*$/.exec(line);
      return match !== null && match[2] === route && match[1].length > 0;
    });
    if (routeIndex === -1) continue;
    const routeIndent = /^(\s*)/.exec(lines[routeIndex])[1].length;
    let routeEnd = routeIndex + 1;
    while (routeEnd < rowEnd) {
      const line = lines[routeEnd];
      if (line.trim() !== '' && line.search(/\S/) <= routeIndent) break;
      routeEnd += 1;
    }

    if (withImageInput) {
      // Route-level default: every model entry without its own `input` inherits
      // this, which is how the hand-declared router models gain image support.
      const propertyIndent = routeIndent + 2;
      let existing = -1;
      for (let index = routeIndex + 1; index < routeEnd; index += 1) {
        const match = /^(\s*)defaultInput:/.exec(lines[index]);
        if (match === null || match[1].length !== propertyIndent) continue;
        existing = index;
        break;
      }
      const line = `${' '.repeat(propertyIndent)}defaultInput: [text, image]`;
      if (existing === -1) {
        edits.push({ from: routeIndex + 1, to: routeIndex + 1, insert: [line] });
      } else {
        let end = existing + 1;
        while (end < routeEnd && (lines[end].trim() === '' || lines[end].search(/\S/) > propertyIndent)) end += 1;
        edits.push({ from: existing, to: end, insert: [line] });
      }
    }

    for (const [modelId, efforts] of planned.get(route)) {
      const header = new RegExp(`^(\\s*)- id:\\s*${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
      let entryStart = -1;
      let entryIndent = 0;
      for (let index = routeIndex + 1; index < routeEnd; index += 1) {
        const match = header.exec(lines[index]);
        if (match === null) continue;
        entryStart = index;
        entryIndent = match[1].length;
        break;
      }
      if (entryStart === -1) continue;
      let entryEnd = entryStart + 1;
      while (entryEnd < routeEnd) {
        const match = /^(\s*)- id: /.exec(lines[entryEnd]);
        if (match !== null && match[1].length <= entryIndent) break;
        entryEnd += 1;
      }
      while (entryEnd - 1 > entryStart && lines[entryEnd - 1].trim() === '') entryEnd -= 1;

      const fieldIndent = entryIndent + 2;
      let dropFrom = -1;
      let dropTo = -1;
      for (let index = entryStart + 1; index < entryEnd; index += 1) {
        const match = /^(\s*)reasoningEfforts:/.exec(lines[index]);
        if (match === null || match[1].length !== fieldIndent) continue;
        let end = index + 1;
        while (end < entryEnd && (lines[end].trim() === '' || lines[end].search(/\S/) > fieldIndent)) end += 1;
        dropFrom = index;
        dropTo = end;
        break;
      }

      const block = [
        `${' '.repeat(fieldIndent)}reasoningEfforts:`,
        ...LEVELS.filter((level) => Object.hasOwn(efforts, level)).map((level) => `${' '.repeat(fieldIndent + 2)}${level}: ${efforts[level]}`),
      ];
      edits.push(dropFrom === -1 ? { from: entryEnd, to: entryEnd, insert: block } : { from: dropFrom, to: dropTo, insert: block });
    }
  }

  if (edits.length === 0) return { lines, changed: false };
  const insertAt = new Map();
  const dropped = new Set();
  for (const edit of edits) {
    insertAt.set(edit.from, [...(insertAt.get(edit.from) ?? []), ...edit.insert]);
    for (let index = edit.from; index < edit.to; index += 1) dropped.add(index);
  }
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (insertAt.has(index)) out.push(...insertAt.get(index));
    if (!dropped.has(index)) out.push(lines[index]);
  }
  return { lines: out, changed: out.length !== lines.length || out.some((line, index) => line !== lines[index]) };
}

/**
 * Apply {@link planPatchEdits} to the profile patch, atomically.
 * @param {string} path - profile patch path.
 * @param {Map<string, Map<string, Record<string, string>>>} planned - route -> model id -> efforts.
 * @param {string} entryId - profile row to edit.
 * @param {boolean} [withImageInput] - also declare route image input.
 * @returns {boolean} whether the file changed.
 */
function writePatchFile(path, planned, entryId, withImageInput = false) {
  const raw = readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const edited = planPatchEdits(raw.split(/\r?\n/), planned, entryId, withImageInput);
  if (!edited.changed) return false;
  const temporary = `${path}.custom-endpoint-effort.tmp`;
  writeFileSync(temporary, edited.lines.join(eol), 'utf8');
  renameSync(temporary, path);
  return true;
}

/**
 * Mount the on-demand effort sync.
 * @param {any} ctx - plugin context.
 * @param {any} config - raw plugin config.
 */
export function apply(ctx, config) {
  const status = createStatus(config);
  const options = normalizeConfig(config);
  const log = (level, message, ...rest) => {
    const logger = ctx.logger;
    if (logger === undefined || typeof logger[level] !== 'function') return;
    logger[level](`custom-endpoint-effort: ${message}`, ...rest);
  };

  const inflight = new Map();
  const lastSync = new Map();
  const cache = createCache(config);

  /**
   * Fetch one custom route's listing and write back any changed levels.
   * @param {string} route - provider route the catalog asked about.
   * @returns {Promise<object | undefined>} sync report, or undefined for a
   *   cache hit or a route this plugin does not manage.
   */
  const syncRoute = async (route) => {
    const report = { route, listed: 0, models: 0, changes: [], dropped: [], imageInput: false, wrote: false, via: null, error: null };
    try {
      const editor = ctx.get('configEditor');
      if (editor === undefined) throw new Error('no config editor is mounted; nothing can be written');
      const entry = editor.entries().find((candidate) => candidate.options.id === options.entryId);
      if (entry === undefined) throw new Error(`profile row "${options.entryId}" is not loaded`);
      const row = editor.configuration().find((candidate) => candidate?.entry?.options?.id === options.entryId);
      const providers = { ...(row?.inherited?.providers ?? {}), ...(row?.override?.providers ?? {}) };
      const profile = providers[route];
      if (profile === null || typeof profile !== 'object') return undefined;
      const api = typeof profile.api === 'string' ? profile.api : 'openai-completions';
      if (!LISTABLE.has(api)) return undefined;
      if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) return undefined;
      if (!Array.isArray(profile.models) || profile.models.length === 0) return undefined;
      const cached = lastSync.get(route) ?? cache.get(route);
      const age = cached === undefined ? undefined : Date.now() - cached.fetchedAt;
      if (age !== undefined && age >= 0 && age < options.refreshMs
        && cached.fingerprint === profileFingerprint(profile)) {
        lastSync.set(route, cached);
        return undefined;
      }
      const configuredInput = Array.isArray(profile.defaultInput) ? profile.defaultInput : [];
      const needsImageInput = !configuredInput.includes('image');
      report.imageInput = needsImageInput;

      const listing = await fetchListing(ctx, profile, options.timeoutMs);
      report.listed = listing.length;
      report.models = profile.models.length;
      const byId = new Map();
      for (const item of listing) {
        if (item === null || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : typeof item.slug === 'string' ? item.slug : undefined;
        if (id !== undefined) byId.set(id, item);
      }

      const changes = new Map();
      for (const model of profile.models) {
        if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue;
        const names = publishedEfforts(byId.get(model.id));
        const efforts = toEfforts(names);
        if (efforts === undefined) {
          if (names !== undefined) report.dropped.push({ id: model.id, names: names.filter((entry) => !ALIASES.has(entry)) });
          continue;
        }
        if (sameEfforts(model.reasoningEfforts, efforts)) continue;
        changes.set(model.id, efforts);
        report.changes.push({ id: model.id, to: efforts });
      }
      // Cache the post-sync declarations: our own write must not trigger
      // another fetch when the adapter-change event rebuilds the catalog.
      report.fingerprint = profileFingerprint({
        ...profile,
        defaultInput: needsImageInput ? IMAGE_INPUT : profile.defaultInput,
        models: profile.models.map((model) => changes.has(model?.id)
          ? { ...model, reasoningEfforts: changes.get(model.id) } : model),
      });
      if (changes.size === 0 && !needsImageInput) {
        status({ phase: 'sync', ...report });
        return report;
      }

      try {
        await editor.edit(entry, (current) => {
          const nextProviders = structuredClone(current.providers ?? {});
          const nextProfile = nextProviders[route];
          if (nextProfile === null || typeof nextProfile !== 'object' || !Array.isArray(nextProfile.models)) {
            throw new Error(`route "${route}" is no longer writable in row "${options.entryId}"`);
          }
          if (needsImageInput) nextProfile.defaultInput = [...IMAGE_INPUT];
          nextProfile.models = nextProfile.models.map((model) => {
            const efforts = typeof model?.id === 'string' ? changes.get(model.id) : undefined;
            return efforts === undefined ? model : { ...model, reasoningEfforts: efforts };
          });
          return { ...current, providers: nextProviders };
        });
        report.via = 'config-editor';
        report.wrote = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A hot-reloaded plugin applies inside the HMR transaction that
        // replaced it, and that transaction refuses nested edits. The profile
        // patch is then the only way through; the same watcher recomposes it.
        if (!/cannot be nested/i.test(message)) throw error;
        const patchPath = editor.documentPath;
        if (typeof patchPath !== 'string' || patchPath.length === 0) throw error;
        report.wrote = writePatchFile(patchPath, new Map([[route, changes]]), options.entryId, needsImageInput);
        report.via = 'patch-file';
      }
      log('info', 'route %s: %d model(s) updated via %s%s', route, changes.size, report.via, needsImageInput ? ', image input enabled' : '');
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      log('warn', 'route %s sync failed: %s', route, report.error);
    }
    status({ phase: 'sync', ...report });
    return report;
  };

  /**
   * Share in-flight syncs; syncRoute checks expiry and the current model list.
   * Failures are not cached: the next catalog read retries.
   * @param {string} provider - route the Host catalog is about to read.
   * @returns {Promise<void>}
   */
  const ensureFresh = (provider) => {
    if (options.routes.length > 0 && !options.routes.includes(provider)) return Promise.resolve();
    const running = inflight.get(provider);
    if (running !== undefined) return running;
    const promise = syncRoute(provider)
      .then((report) => {
        if (report === undefined || report.error !== null) return;
        const record = { fetchedAt: Date.now(), fingerprint: report.fingerprint };
        lastSync.set(provider, record);
        cache.set(provider, record);
      })
      .finally(() => {
        inflight.delete(provider);
      });
    inflight.set(provider, promise);
    return promise;
  };

  // The picker and /model command read the catalog through llm.listModels.
  // Refresh missing/new-model efforts here, while ordinary reads use the
  // five-minute cache.
  //
  // Reloads can leave wrappers from earlier plugin instances on the service if
  // their disposer ran after another instance had already replaced the method,
  // so peel any previous wrapper chain before installing this one.
  ctx.effect(() => {
    const llm = ctx.llm;
    // The class method, not whatever earlier plugin instances left on the
    // instance: a reload whose disposer lost the race must not leave its stale
    // wrapper in front of the real implementation.
    const prototype = Object.getPrototypeOf(llm);
    const original = typeof prototype?.listModels === 'function' ? prototype.listModels : llm.listModels;
    const wrapped = async function (provider, ...rest) {
      await ensureFresh(provider);
      return original.call(this, provider, ...rest);
    };
    llm.listModels = wrapped;
    return () => {
      if (llm.listModels === wrapped) llm.listModels = original;
    };
  }, 'custom-endpoint-effort listModels wrapper');

  // Register the client bundle in the running Host's client-module graph.
  // dsh-client-modules reads each package's dsh.client declaration once at
  // boot and caches "no client" for a package that had none then; a profile
  // live reload therefore cannot discover the client half added later. Clear
  // that one cached miss and rerun the service's own dirty scan, so only a
  // page refresh is needed instead of a Host restart. Best effort: on any
  // refusal the plugin still works and a restart does the same thing.
  ctx.inject(['clientModules'], (scope) => {
    try {
      const modules = scope.clientModules;
      const entry = '@local/dsh-custom-endpoint-effort';
      if (modules === undefined || modules.table?.has(entry) === true) return;
      if (!(modules.pkgMeta instanceof Map) || !(modules.dirty instanceof Set) || typeof modules.flush !== 'function') return;
      let cleared = false;
      for (const key of [...modules.pkgMeta.keys()]) {
        if (typeof key === 'string' && key.includes(entry)) {
          modules.pkgMeta.delete(key);
          cleared = true;
        }
      }
      if (!cleared) return;
      modules.dirty.add(entry);
      modules.flush((error) => log('warn', 'client bundle registration failed: %s', error instanceof Error ? error.message : String(error)));
      status({ phase: 'client-registered', updatedAt: new Date().toISOString() });
    } catch (error) {
      log('warn', 'client bundle registration was refused: %s', error instanceof Error ? error.message : String(error));
    }
  });

  status({ phase: 'loaded', plugin: name, entryId: options.entryId, routes: options.routes, refreshMs: options.refreshMs, pid: process.pid });
  log('info', 'syncing row "%s" on catalog reads (refreshMs %d)', options.entryId, options.refreshMs);
}
