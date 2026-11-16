import { readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// This package lives outside the profile's node_modules, so resolve DSH's own
// runtime packages through the launcher just like the session-mover plugin.
// ponytail: the launcher path is the supported Host activation boundary.
const launcher = process.env.DSH_MINIMAX_IMPORTER_ENTRY ?? process.argv[1];
if (launcher === undefined) throw new Error('minimax-session-importer: cannot resolve the DSH runtime entry');
const dshRequire = createRequire(realpathSync(launcher));
const { TypertRemoteService, Remote, RemoteError } = await import(dshRequire.resolve('@deepseek-ai/dsh-typert-protocol'));
const { appendPluginRecord } = await import(dshRequire.resolve('@deepseek-ai/dsh-session'));

const ROOT = path.join(homedir(), '.minimax', 'v2', 'sessions');
const DATABASE = path.join(ROOT, '..', 'sqlite', 'runtime-state.sqlite');
const SOURCE_RECORD = 'plugin:minimax-session-importer/source';
const IMPORTED_ID_PREFIX = 'minimax-import-';

const CODE = {
  badRequest: 'minimax-sync/bad-request',
  notFound: 'minimax-sync/not-found',
  empty: 'minimax-sync/empty',
  sourceMissing: 'minimax-sync/source-missing',
  ambiguous: 'minimax-sync/ambiguous',
  divergent: 'minimax-sync/divergent',
  active: 'minimax-sync/source-active',
  readFailed: 'minimax-sync/read-failed',
  writeFailed: 'minimax-sync/write-failed',
  needsRepair: 'minimax-sync/needs-repair',
};

const SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const SEQUENCE_REFERENCE_FIELDS = new Set(['sourceEventSeqs', 'messageSeqs', 'headerSeq', 'startSeq', 'endSeq']);

function failure(code, message, details = {}) {
  return new RemoteError(code, message, details);
}

function openCatalog() {
  return new DatabaseSync(DATABASE, { readOnly: true });
}

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(full));
    else if (entry.name === 'manifest.json') result.push(full);
  }
  return result;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && (part.type === 'text' || part.type === 'output_text'))
    .map((part) => part.text || '').join('');
}

function importedText(message) {
  const text = textOf(message?.content);
  return message?.role === 'user'
    ? text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/gi, '').trim()
    : text.trim();
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function normalizeTitle(value) {
  return normalizeText(value);
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function firstSurfaceEvent(events) {
  return events.find((event) => SURFACE_EVENT_TYPES.has(event.type));
}

function hasProtectedFirstSurfaceHead(events) {
  const first = firstSurfaceEvent(events);
  return first?.type === 'system/message' && first.surfaceOp === 'append';
}

function remapSequence(value, map) {
  if (Array.isArray(value)) return value.map((item) => remapSequence(item, map));
  return typeof value === 'number' && map.has(value) ? map.get(value) : value;
}

/** Rewrite one event's own sequence and every stored sequence reference through `map`. */
function remapEvent(event, map) {
  const next = { ...event, seq: map.get(event.seq) };
  for (const field of SEQUENCE_REFERENCE_FIELDS) {
    if (next[field] !== undefined) next[field] = remapSequence(next[field], map);
  }
  if (next.surfaceOp && typeof next.surfaceOp === 'object') {
    next.surfaceOp = { ...next.surfaceOp,
      startSeq: remapSequence(next.surfaceOp.startSeq, map),
      endSeq: remapSequence(next.surfaceOp.endSeq, map),
    };
  }
  if (next.data && typeof next.data === 'object') {
    next.data = { ...next.data };
    for (const field of SEQUENCE_REFERENCE_FIELDS) {
      if (next.data[field] !== undefined) next.data[field] = remapSequence(next.data[field], map);
    }
  }
  return next;
}

/**
 * Insert the protected first system surface head into a legacy imported log.
 * DSH admits a `system/message` only inside an open turn and step, so the head
 * goes right after the first `step/start` and the first user message moves to
 * sit just behind it — exactly the order a DSH-created session writes. No
 * message content changes, and this returns new events without mutating the
 * caller's history.
 * ponytail: the move forces an O(n) sequence/reference remap; the original
 * compressed log must be backed up before persistence rewrites it.
 */
function repairProtectedHead(events, sessionId) {
  if (hasProtectedFirstSurfaceHead(events)) return { changed: false, events: [...events] };
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) throw new Error(`cannot repair an imported session with a non-contiguous sequence at ${index}`);
  }
  const firstIndex = events.findIndex((event) => SURFACE_EVENT_TYPES.has(event.type));
  if (firstIndex < 0) throw new Error('cannot repair an imported session with no surface events');
  if (events[firstIndex].type !== 'user/message') throw new Error('cannot repair an imported session whose first surface event is not a user/message');
  const stepIndex = events.findIndex((event, index) => index > firstIndex && event.type === 'step/start');
  if (stepIndex < 0) throw new Error('cannot repair an imported session that has no step/start after its first message');
  for (let index = firstIndex + 1; index < stepIndex; index += 1) {
    if (SURFACE_EVENT_TYPES.has(events[index].type)) throw new Error('cannot repair an imported session with surface events before its first step');
  }
  const step = events[stepIndex].data;
  if (!Number.isInteger(step?.turn) || !Number.isInteger(step?.step)) throw new Error('cannot repair an imported session with an unnumbered first step');
  const head = {
    type: 'system/message',
    seq: stepIndex,
    time: events[stepIndex].time,
    data: {
      turn: step.turn,
      step: step.step,
      message: {
        id: `${sessionId}-protected-system-head`,
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
      },
    },
    surfaceOp: 'append',
  };
  const map = new Map();
  for (let old = 0; old < events.length; old += 1) {
    if (old < firstIndex) map.set(old, old);
    else if (old === firstIndex) map.set(old, stepIndex + 1);
    else if (old <= stepIndex) map.set(old, old - 1);
    else map.set(old, old + 1);
  }
  const ordered = [...events.slice(0, firstIndex), ...events.slice(firstIndex + 1, stepIndex + 1), null, events[firstIndex], ...events.slice(stepIndex + 1)];
  const repaired = ordered.map((event) => event === null ? head : remapEvent(event, map));
  for (let index = 0; index < repaired.length; index += 1) {
    if (repaired[index].seq !== index) throw new Error(`protected-head repair produced a non-contiguous sequence at ${index}`);
  }
  if (!hasProtectedFirstSurfaceHead(repaired)) throw new Error('protected-head repair did not produce a first surface system head');
  return { changed: true, events: repaired };
}

function assertProtectedSeed(seed) {
  if (!hasProtectedFirstSurfaceHead(seed)) throw new Error('import seed must begin its surface with a protected system/message head');
}

function importedMessages(messages) {
  return messages.map((item) => {
    const role = item.message?.role;
    const text = importedText(item.message);
    return role === 'user' || role === 'assistant' ? { role, text } : null;
  }).filter((message) => message !== null && message.text !== '');
}

function dshMessages(events) {
  return events.map((event) => {
    const message = event.type === 'user/message'
      ? event.data
      : event.type === 'assistant/message'
        ? event.data?.message
        : null;
    if (message?.role !== 'user' && message?.role !== 'assistant') return null;
    const text = importedText(message);
    return text === '' ? null : { role: message.role, text };
  }).filter((message) => message !== null);
}

function sameMessage(left, right) {
  return left?.role === right?.role && normalizeText(left?.text) === normalizeText(right?.text);
}

function isPrefix(prefix, full) {
  if (prefix.length > full.length) return false;
  return prefix.every((message, index) => sameMessage(message, full[index]));
}

function sourceRecordOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== SOURCE_RECORD || event.ignorable !== true) continue;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.sourceSessionId !== 'string') continue;
    const count = Number.isInteger(data.importedMessageCount) ? data.importedMessageCount : undefined;
    return { ...data, ...(count === undefined ? {} : { importedMessageCount: count }) };
  }
  return undefined;
}

function titleOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title;
  }
  return '';
}

function sourceData(session, sourceMessageCount) {
  return {
    sourceSessionId: session.sessionId,
    sourceTitle: session.title,
    sourceProjectFolder: session.projectFolder,
    importedMessageCount: sourceMessageCount,
  };
}

async function listSessions() {
  // The catalog, not manifest timestamps or directory enumeration, owns names and activity.
  // Include archived, hidden, branch, task, and database-only sessions without a list cap.
  const db = openCatalog();
  let catalog;
  try {
    catalog = db.prepare(`SELECT s.*, p.workspace_dir AS project_path,
      coalesce(m.message_count, 0) AS message_count
      FROM local_runtime_sessions s
      LEFT JOIN local_runtime_projects p ON p.project_id = s.project_id
      LEFT JOIN (SELECT session_id, count(*) AS message_count
        FROM local_runtime_message_rows GROUP BY session_id) m ON m.session_id = s.session_id`).all();
  } finally { db.close(); }
  const rows = new Map(catalog.map((record) => {
    const old = JSON.parse(record.record_json || '{}');
    const projectFolder = record.project_workspace_dir || record.project_path || record.workspace_dir || old.projectWorkspaceDir || old.workspaceDir || null;
    const relativeDir = record.history_relative_dir;
    return [record.session_id, {
      key: record.session_id, sessionId: record.session_id,
      title: record.title || old.title || 'Unnamed session',
      projectFolder,
      updatedAtMs: record.updated_at_ms || old.updatedAtMs || 0,
      createdAtMs: record.created_at_ms || old.createdAtMs || 0,
      messageCount: record.message_count,
      archived: !!record.archived,
      visibility: record.visibility,
      file: relativeDir ? path.join(ROOT, relativeDir, 'manifest.json') : null,
      historySource: 'database',
    }];
  }));
  const warnings = [];
  // ponytail: retain filesystem-only legacy sessions too; report unreadable manifests.
  let manifests = [];
  try { manifests = await filesUnder(ROOT); }
  catch (error) { warnings.push(`History directory scan: ${error.message}`); }
  for (const file of manifests) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (!manifest.sessionId || rows.has(manifest.sessionId)) continue;
      rows.set(manifest.sessionId, {
        key: manifest.sessionId, sessionId: manifest.sessionId,
        title: manifest.title || 'Unnamed session',
        projectFolder: manifest.projectWorkspaceDir || manifest.workspaceDir || manifest.cwd || null,
        updatedAtMs: manifest.updatedAtMs || manifest.createdAtMs || 0,
        createdAtMs: manifest.createdAtMs || 0,
        messageCount: null, file, historySource: 'file',
      });
    } catch (error) { warnings.push(`${file}: ${error.message}`); }
  }
  return { sessions: [...rows.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs), warnings, catalogCount: catalog.length };
}

async function readMessages(session) {
  const db = openCatalog();
  let rows;
  try {
    rows = db.prepare(`SELECT data_json, role, created_at_ms, msg_id
      FROM local_runtime_message_rows WHERE session_id = ? ORDER BY id`).all(session.sessionId);
  } finally { db.close(); }
  if (rows.length) return rows.map((row) => {
    const data = JSON.parse(row.data_json);
    return {
      timestamp: data.timestamp || row.created_at_ms,
      message: { role: data.role || row.role, content: data.msg_content ?? data.message?.content ?? data.content ?? '' },
    };
  });
  if (!session.file) throw new Error('No transcript is available in the database or history directory.');
  const file = path.join(path.dirname(session.file), 'messages.jsonl');
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function buildSeed(sessionId, sourceMessages, title, source) {
  const seed = [];
  const add = (type, data, time, surface = false, ignorable = false) => {
    seed.push({ type, seq: seed.length, time, data,
      ...(surface ? { surfaceOp: 'append' } : {}),
      ...(ignorable ? { ignorable: true } : {}) });
  };
  // A user-source title pins the original name before automatic title generation can run.
  add('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, Date.now());
  const normalized = importedMessages(sourceMessages);
  add(SOURCE_RECORD, sourceData(source, normalized.length), Date.now(), false, true);
  let turn = 0;
  let step = 0;
  let protectedHeadAdded = false;
  let openStep = false;
  for (const item of sourceMessages) {
    const role = item.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = importedText(item.message);
    if (!text) continue;
    const time = Number(item.timestamp) || Date.now();
    if (role === 'user' || turn === 0) {
      if (turn) {
        if (openStep) {
          add('step/end', { turn, step }, time);
          openStep = false;
        }
        add('turn/end', { turn, reason: { kind: 'completed' } }, time);
      }
      turn++;
      step = 0;
      add('turn/start', { turn }, time);
      if (!protectedHeadAdded) {
        step = 1;
        add('step/start', { turn, step }, time);
        // The live system-prompt projection replaces this empty node with the current prompt.
        add('system/message', {
          turn,
          step,
          message: {
            id: `${sessionId}-system-head`,
            role: 'system',
            content: [],
            source: { kind: 'system-prompt' },
          },
        }, time, true);
        protectedHeadAdded = true;
        openStep = true;
      }
    }
    const message = { id: `${sessionId}-message-${seed.length}`, role, content: [{ type: 'text', text }],
      source: role === 'assistant' ? { kind: 'model', provider: 'minimax-import', model: 'imported-session' } : { kind: 'user' } };
    if (role === 'assistant') {
      if (!openStep) {
        step++;
        add('step/start', { turn, step }, time);
        openStep = true;
      }
      add('assistant/message', { turn, step, message, stream: [] }, time, true);
      add('step/end', { turn, step }, time);
      openStep = false;
    } else add('user/message', message, time, true);
  }
  if (turn) {
    if (openStep) add('step/end', { turn, step }, Date.now());
    add('turn/end', { turn, reason: { kind: 'completed' } }, Date.now());
  }
  return seed;
}

async function importSession(session, ctx) {
  if (!session.projectFolder) throw new Error('Original project folder is unknown; refusing to attach the import to the wrong folder.');
  const sourceMessages = await readMessages(session);
  const normalized = importedMessages(sourceMessages);
  const sessionId = `${IMPORTED_ID_PREFIX}${randomUUID()}`;
  const seed = buildSeed(sessionId, sourceMessages, session.title, session);
  assertProtectedSeed(seed);
  if (normalized.length === 0) throw new Error('This session has no importable user or assistant text.');
  // Register/reuse the original project, canonicalizing it through DSH rather than the storage path.
  const workspace = await ctx.workspaceRegistry.create(session.projectFolder);
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId, meta: { cwd: workspace.path }, seed,
  });
  await workspace.attachSession(handle.agent.id);
  return { id: handle.agent.id, title: session.title, projectFolder: workspace.path, sourceSessionId: session.sessionId, importedMessageCount: normalized.length };
}

function highestTurn(events) {
  let value = 0;
  for (const event of events) {
    const turn = Number(event.data?.turn);
    if (Number.isInteger(turn) && turn > value) value = turn;
  }
  return value;
}

function buildSyncEvents(sessionId, existingEvents, sourceMessages, startIndex, source) {
  const events = [];
  const nextSeq = () => {
    const last = events[events.length - 1] ?? existingEvents[existingEvents.length - 1];
    return last === undefined ? 0 : last.seq + 1;
  };
  const add = (type, data, time, surface = false, ignorable = false) => {
    events.push({ type, seq: nextSeq(), time, data,
      ...(surface ? { surfaceOp: 'append' } : {}),
      ...(ignorable ? { ignorable: true } : {}) });
  };
  const marker = source === undefined ? undefined : sourceData(source.session, source.messageCount);
  if (marker !== undefined) add(SOURCE_RECORD, marker, Date.now(), false, true);

  let turn = highestTurn(existingEvents) + 1;
  let step = 0;
  let openStep = false;
  let started = false;
  const closeTurn = (time) => {
    if (!started) return;
    if (openStep) {
      add('step/end', { turn, step }, time);
      openStep = false;
    }
    add('turn/end', { turn, reason: { kind: 'completed' } }, time);
    started = false;
  };
  for (const item of sourceMessages.slice(startIndex)) {
    const role = item.role;
    if (role !== 'user' && role !== 'assistant' || item.text === '') continue;
    const time = Date.now();
    if (role === 'user' || !started) {
      closeTurn(time);
      turn++;
      step = 1;
      started = true;
      add('turn/start', { turn }, time);
      add('step/start', { turn, step }, time);
      openStep = true;
    }
    const message = {
      id: `${sessionId}-sync-${nextSeq()}`,
      role,
      content: [{ type: 'text', text: item.text }],
      source: role === 'assistant' ? { kind: 'model', provider: 'minimax-import', model: 'synced-session' } : { kind: 'user' },
    };
    if (role === 'assistant') {
      add('assistant/message', { turn, step, message, stream: [] }, time, true);
      add('step/end', { turn, step }, time);
      openStep = false;
    } else add('user/message', message, time, true);
  }
  closeTurn(Date.now());
  return events;
}

function appendEventsToLive(session, events) {
  for (const event of events) {
    if (event.type.startsWith('plugin:')) {
      appendPluginRecord(session, event.type, event.data);
      continue;
    }
    if (event.surfaceOp !== undefined) session.append(event.type, event.data, { surfaceOp: event.surfaceOp });
    else session.append(event.type, event.data);
  }
}

function chooseMatch(matches, currentTitle, cwd) {
  if (matches.length === 0) return undefined;
  const normalizedCurrentTitle = normalizeTitle(currentTitle);
  const normalizedCwd = normalizePath(cwd);
  const scored = matches.map((match) => ({
    ...match,
    score: (normalizeTitle(match.session.title) === normalizedCurrentTitle ? 4 : 0)
      + (normalizePath(match.session.projectFolder) === normalizedCwd ? 2 : 0)
      + (match.sourceMessages.length === match.currentMessages.length ? 1 : 0),
  })).sort((left, right) => right.score - left.score);
  const best = scored[0];
  const tied = scored.filter((match) => match.score === best.score);
  if (tied.length !== 1) throw failure(CODE.ambiguous, 'multiple MiniMax sessions have the same matching content; refusing to guess', { candidates: tied.map((match) => ({ sessionId: match.session.sessionId, title: match.session.title, projectFolder: match.session.projectFolder })) });
  return { ...best, matchedBy: normalizeTitle(best.session.title) === normalizedCurrentTitle ? 'title-and-content' : 'content' };
}

async function findCounterpart(currentTitle, cwd, currentMessages, marker) {
  const { sessions } = await listSessions();
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const sourceId = marker?.sourceSessionId;
  const recorded = sourceId !== undefined && byId.has(sourceId);
  const title = normalizeTitle(currentTitle);
  const project = normalizePath(cwd);
  const named = sessions.filter((session) => normalizeTitle(session.title) === title && (project === '' || normalizePath(session.projectFolder) === project));
  // Try the strongest identity first, then fall back to a complete content scan if
  // either side renamed the session or an exact-title candidate has stale content.
  // ponytail: this is an O(n) catalog scan; a future source index could avoid it.
  const candidateGroups = recorded ? [[byId.get(sourceId)]] : (named.length ? [named, sessions] : [sessions]);
  const expectedCount = marker?.importedMessageCount;
  const seen = new Set();
  const shorterPrefixes = [];
  for (const candidates of candidateGroups) {
    const matches = [];
    for (const session of candidates) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      let sourceMessages;
      try { sourceMessages = importedMessages(await readMessages(session)); }
      catch { continue; }
      const compareCount = expectedCount === undefined ? currentMessages.length : expectedCount;
      if (compareCount <= 0 || currentMessages.length !== compareCount) {
        if (recorded) throw failure(CODE.divergent, 'the imported DSH session has local messages beyond its recorded MiniMax history; refusing to append out of order', { sessionId: session.sessionId, expectedCount: compareCount, actualCount: currentMessages.length });
        continue;
      }
      if (sourceMessages.length < compareCount) {
        if (isPrefix(sourceMessages, currentMessages)) shorterPrefixes.push(session);
        continue;
      }
      if (!isPrefix(currentMessages.slice(0, compareCount), sourceMessages)) continue;
      matches.push({ session, sourceMessages, currentMessages });
    }
    if (matches.length > 0) return chooseMatch(matches, currentTitle, cwd);
  }

  if (shorterPrefixes.length > 0) throw failure(CODE.divergent, 'the imported DSH session has messages that are not present in the MiniMax counterpart; refusing to append out of order', { candidates: shorterPrefixes.map((session) => session.sessionId), actualCount: currentMessages.length });
  if (recorded) throw failure(CODE.sourceMissing, `the recorded MiniMax counterpart "${sourceId}" is missing or its history no longer matches`, { sourceSessionId: sourceId });
  throw failure(CODE.sourceMissing, 'no MiniMax session has a matching imported message history', { title: currentTitle });
}

async function syncSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(IMPORTED_ID_PREFIX)) throw failure(CODE.badRequest, 'sync is available only for imported MiniMax sessions', { sessionId });
  const live = ctx.agents.get(sessionId);
  if (live?.status === 'running') throw failure(CODE.active, 'the imported session is still running; wait for it to become idle before syncing', { sessionId });

  let observation;
  let currentEvents;
  try {
    if (live !== undefined) currentEvents = [...live.session.snapshotEvents()];
    else {
      observation = await ctx.sessionQuery.observeSession(sessionId);
      currentEvents = [...observation.events];
    }
  } catch (error) {
    throw failure(CODE.readFailed, `could not read the imported DSH session: ${error instanceof Error ? error.message : String(error)}`, { sessionId });
  } finally {
    if (observation !== undefined && live === undefined) observation[Symbol.dispose]?.();
  }
  if (currentEvents.length === 0) throw failure(CODE.empty, 'the imported DSH session has no history', { sessionId });
  if (!hasProtectedFirstSurfaceHead(currentEvents)) throw failure(CODE.needsRepair, 'this imported session predates the protected system-head fix; repair it before syncing', { sessionId });

  const marker = sourceRecordOf(currentEvents);
  const currentMessages = dshMessages(currentEvents);
  if (currentMessages.length === 0) throw failure(CODE.empty, 'the imported DSH session has no user or assistant text to match', { sessionId });
  const currentTitle = titleOf(currentEvents);
  const cwd = live?.session.header.cwd ?? currentEvents[0]?.cwd ?? '';
  const match = await findCounterpart(currentTitle, cwd, currentMessages, marker);
  const startIndex = marker?.importedMessageCount ?? currentMessages.length;
  if (match.sourceMessages.length < startIndex) throw failure(CODE.divergent, 'the MiniMax counterpart is shorter than the imported DSH history', { sourceSessionId: match.session.sessionId, importedMessageCount: startIndex, sourceMessageCount: match.sourceMessages.length });
  const suffix = match.sourceMessages.slice(startIndex);
  const source = { session: match.session, messageCount: match.sourceMessages.length };

  if (live !== undefined) {
    if (live.status === 'running') throw failure(CODE.active, 'the imported session started running during sync; no changes were made', { sessionId });
    const fresh = [...live.session.snapshotEvents()];
    if (dshMessages(fresh).length !== currentMessages.length) throw failure(CODE.divergent, 'the imported session changed while it was being matched; retry sync', { sessionId });
    const freshMarker = sourceRecordOf(fresh);
    const includeMarker = freshMarker === undefined || freshMarker.sourceSessionId !== match.session.sessionId || freshMarker.importedMessageCount !== match.sourceMessages.length;
    const append = buildSyncEvents(sessionId, fresh, suffix, 0, includeMarker ? source : undefined);
    appendEventsToLive(live.session, append);
    return { sessionId, sourceSessionId: match.session.sessionId, sourceTitle: match.session.title, matchedBy: marker ? 'recorded-source' : match.matchedBy, appendedMessages: suffix.length, status: suffix.length === 0 ? 'already-current' : 'synced' };
  }

  let handle;
  try {
    handle = await ctx.sessionPersistence.open(sessionId, 'write');
    const read = await handle.read();
    const persisted = [...read.events];
    if (dshMessages(persisted).length !== currentMessages.length) throw failure(CODE.divergent, 'the imported session changed while it was being matched; retry sync', { sessionId });
    const persistedMarker = sourceRecordOf(persisted);
    const includeMarker = persistedMarker === undefined || persistedMarker.sourceSessionId !== match.session.sessionId || persistedMarker.importedMessageCount !== match.sourceMessages.length;
    const append = buildSyncEvents(sessionId, persisted, suffix, 0, includeMarker ? source : undefined);
    if (append.length > 0) {
      await handle.append(append);
      await handle.flush();
    }
    return { sessionId, sourceSessionId: match.session.sessionId, sourceTitle: match.session.title, matchedBy: marker ? 'recorded-source' : match.matchedBy, appendedMessages: suffix.length, status: suffix.length === 0 ? 'already-current' : 'synced' };
  } catch (error) {
    if (error?.isDSHRemoteError === true) throw error;
    throw failure(CODE.writeFailed, `could not append the MiniMax changes: ${error instanceof Error ? error.message : String(error)}`, { sessionId });
  } finally {
    await handle?.close();
  }
}

function registerCommands(ctx) {
  const listDisposer = ctx.commands.register({
    name: 'minimax-sessions',
    description: 'List all MiniMax Code sessions with saved names and original project folders.',
    handler: async () => ({ kind: 'success', text: JSON.stringify(await listSessions()) }),
  });
  const importDisposer = ctx.commands.register({
    name: 'minimax-import',
    description: 'Import selected MiniMax sessions with their saved names into their original projects.',
    input: { hint: 'JSON array of MiniMax session keys' },
    handler: async (invocation) => {
      const keys = JSON.parse(invocation.rawInput || '[]');
      if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== 'string')) return { kind: 'error', text: 'Select at least one MiniMax session.' };
      const { sessions } = await listSessions();
      const byKey = new Map(sessions.map((session) => [session.key, session]));
      const imported = [], failures = [];
      for (const key of new Set(keys)) {
        const session = byKey.get(key);
        if (!session) { failures.push({ key, error: 'Session is not in the current MiniMax catalog.' }); continue; }
        try { imported.push(await importSession(session, ctx)); }
        catch (error) { failures.push({ key, title: session.title, error: error.message }); }
      }
      return { kind: 'success', text: JSON.stringify({ imported, failures }) };
    },
  });
  return () => { listDisposer(); importDisposer(); };
}

class MiniMaxSessionImporter extends TypertRemoteService {
  static inject = ['commands', 'agentLoop', 'workspaceRegistry', 'agents', 'sessionPersistence', 'sessionQuery'];

  constructor(ctx) {
    super(ctx, 'minimaxSessionSync');
    ctx.effect(() => registerCommands(ctx), 'minimax-session-importer: commands');
  }

  sync(sessionId) {
    return syncSession(this.ctx, sessionId);
  }
}

{
  const proto = MiniMaxSessionImporter.prototype;
  Remote(proto.sync, {
    private: false,
    static: false,
    name: 'sync',
    addInitializer(initializer) {
      initializer.call(Object.create(proto));
    },
  });
}

export { assertProtectedSeed, buildSeed, buildSyncEvents, dshMessages, findCounterpart, firstSurfaceEvent, hasProtectedFirstSurfaceHead, importedMessages, listSessions, readMessages, repairProtectedHead, sourceRecordOf, syncSession };
export default MiniMaxSessionImporter;
