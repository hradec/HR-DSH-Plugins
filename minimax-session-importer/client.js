window.__ModuleLoader__.load({
  id: '@local/minimax-session-importer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const css = `
      .mm-importer { color: var(--dsw-alias-label-primary); font-size: 12px; }
      .mm-importer button { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 9px; cursor: pointer; }
      .mm-importer button:hover { border-color: var(--dsw-alias-brand-primary); }
      .mm-importer-panel { position: fixed; z-index: 100; left: 64px; bottom: 56px; padding: 12px; width: min(420px, calc(100vw - 88px)); box-sizing: border-box; max-height: calc(100vh - 80px); overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
      .mm-importer-list { max-height: 220px; overflow: auto; margin: 8px 0; }
      .mm-importer-row { display: flex; gap: 7px; align-items: flex-start; padding: 4px 0; }
      .mm-importer-muted { color: var(--dsw-alias-label-secondary); }
      .mm-importer-error { color: var(--dsw-alias-state-error-primary); }
      .mm-sync-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483000; max-width: min(620px, calc(100vw - 32px)); box-sizing: border-box; padding: 9px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #24272b); color: var(--dsw-alias-label-primary, #f5f6f7); border: .5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.14)); box-shadow: 0 8px 28px rgba(0,0,0,.28); font: 13px/19px inherit; white-space: pre-wrap; pointer-events: none; opacity: 0; transition: opacity 120ms ease, transform 120ms ease; }
      .mm-sync-toast[data-shown] { opacity: 1; transform: translate(-50%, -4px); }
      .mm-sync-toast[data-kind='error'] { border-color: var(--dsw-alias-state-error-primary, #e05555); }
    `;

    function resultText(response) {
      if (!response?.ok) throw new Error(response?.error?.message || 'MiniMax command request failed.');
      const execution = response.value;
      if (!execution) throw new Error('The MiniMax importer command is not available.');
      if (execution.result.kind === 'error') throw new Error(execution.result.text);
      if (!execution.result.text) throw new Error('The MiniMax importer returned no data.');
      return JSON.parse(execution.result.text);
    }

    function Importer(props) {
      const remote = props.remote;
      const [open, setOpen] = React.useState(false);
      const [rows, setRows] = React.useState([]);
      const [filter, setFilter] = React.useState('');
      const [selected, setSelected] = React.useState({});
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const triggerRef = React.useRef(null);
      const commandSession = React.useRef(props.sessionId || null);
      const close = () => {
        setOpen(false);
        triggerRef.current?.focus();
      };
      React.useEffect(() => {
        if (!open) return;
        const onEscape = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          close();
        };
        window.addEventListener('keydown', onEscape, true);
        return () => window.removeEventListener('keydown', onEscape, true);
      }, [open]);
      const load = async () => {
        setOpen(true);
        setBusy(true); setStatus('Loading MiniMax sessions…');
        try {
          if (!commandSession.current) {
            const created = await remote.session.create({});
            if (!created.ok) throw new Error(created.error.message);
            commandSession.current = created.value.sessionId;
          }
          const execution = await remote.commands.execute(commandSession.current, '/minimax-sessions', [], new AbortController().signal);
          const data = resultText(execution);
          setRows(data?.sessions || []);
          setStatus(`Loaded ${data.sessions.length} sessions, including archived and hidden sessions.${data.warnings?.length ? ' Warnings: ' + data.warnings.join('; ') : ''}`);
        } catch (error) { setStatus(String(error)); }
        setBusy(false);
      };
      const importSelected = async () => {
        const keys = Object.keys(selected).filter((key) => selected[key]);
        if (!keys.length) { setStatus('Select at least one session.'); return; }
        setBusy(true); setStatus('Importing…');
        try {
          const execution = await remote.commands.execute(commandSession.current, `/minimax-import ${JSON.stringify(keys)}`, [], new AbortController().signal);
          const data = resultText(execution);
          const failures = data.failures || [];
          setStatus(`Imported ${data.imported.length} session(s).${failures.length ? ' Failed: ' + failures.map((failure) => `${failure.title || failure.key}: ${failure.error}`).join('; ') : ''}`);
          setSelected(Object.fromEntries(failures.map((failure) => [failure.key, true])));
        } catch (error) { setStatus(String(error)); }
        setBusy(false);
      };
      const query = filter.trim().toLocaleLowerCase();
      const visibleRows = rows.filter((row) => `${row.title || ''} ${row.sessionId || ''} ${row.projectFolder || ''}`.toLocaleLowerCase().includes(query));
      return h('div', { className: 'mm-importer' },
        h('style', null, css),
        h('button', { ref: triggerRef, type: 'button', title: 'Import MiniMax', 'aria-label': 'Import MiniMax', 'aria-expanded': open, disabled: busy, onClick: open ? close : load }, busy ? '…' : props.wide === false ? '⇩' : 'Import MiniMax'),
        open && h('div', { className: 'mm-importer-panel' },
          h('strong', null, 'Local MiniMax Code sessions'),
          h('input', {
            type: 'search', value: filter, placeholder: 'Filter by name, ID, or project folder…',
            'aria-label': 'Filter MiniMax sessions',
            onChange: (event) => setFilter(event.target.value),
            style: { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 8, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
          }),
          h('div', { className: 'mm-importer-list' }, visibleRows.length ? visibleRows.map((row) => h('label', { className: 'mm-importer-row', key: row.key },
            h('input', { type: 'checkbox', checked: !!selected[row.key], onChange: (event) => setSelected({ ...selected, [row.key]: event.target.checked }) }),
            h('span', { style: { minWidth: 0 } },
              h('div', null, row.title),
              h('div', { className: 'mm-importer-muted', title: row.projectFolder || '', style: { overflowWrap: 'anywhere' } }, row.projectFolder || 'Project folder unavailable'),
              h('div', { className: 'mm-importer-muted' }, `${row.messageCount ?? 'File history'} messages${row.archived ? ' · Archived' : ''}${row.visibility === 'hidden' ? ' · Hidden' : ''}`))
          )) : h('div', { className: 'mm-importer-muted' }, rows.length ? 'No sessions match your filter.' : 'No MiniMax sessions found in ~/.minimax.' )),
          h('button', { type: 'button', disabled: busy, onClick: importSelected }, 'Import selected'),
          status && h('div', { className: status.startsWith('Error') ? 'mm-importer-error' : 'mm-importer-muted' }, status)
        )
      );
    }

    const taggedRule = {
      id: 'minimax-tagged-data', order: -100,
      match(text, from) {
        const pattern = /<([A-Za-z][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/g;
        pattern.lastIndex = from;
        const found = pattern.exec(text);
        if (!found) return;
        return { id: 'minimax-tagged-data', start: found.index, end: pattern.lastIndex,
          data: { tag: found[1], body: found[2] } };
      },
    };

    function TaggedData(props) {
      // Presentation only: raw stored/model-visible message text is never rewritten.
      if (!props.sessionId?.startsWith(IMPORTED_ID_PREFIX)) return h('span', null, props.raw);
      const { tag, body } = props.node.data;
      let formatted = body.trim();
      let isJson = false;
      try { formatted = JSON.stringify(JSON.parse(formatted), null, 2); isJson = true; } catch {}
      return h('details', { style: { margin: '6px 0', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '6px 10px', background: 'var(--dsw-alias-bg-layer-1)' } },
        h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' } }, `${tag}${isJson ? ' · JSON' : ''}`),
        h('pre', { style: { margin: '8px 0 0', overflow: 'auto', maxHeight: 360, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)' } },
          h('code', null, formatted)));
    }

    const IMPORTED_ID_PREFIX = 'minimax-import-';

    function failureText(error) {
      switch (error?.code) {
        case 'minimax-sync/source-active': return 'This imported session is running; wait for it to become idle, then sync again.';
        case 'minimax-sync/ambiguous': return 'Several MiniMax sessions have matching content; sync was not applied.';
        case 'minimax-sync/divergent': return 'The DSH history has local changes; sync was not applied.';
        case 'minimax-sync/source-missing': return 'No matching MiniMax history was found; sync was not applied.';
        case 'minimax-sync/needs-repair': return 'This older imported session needs the protected-head repair before it can sync.';
        case 'minimax-sync/not-found': return 'The imported DSH session was not found.';
        default: return `MiniMax sync failed: ${error?.message || String(error)}`;
      }
    }

    function SyncMenuItem({ sessionId, useMenuOpenState, onSync }) {
      const [, setMenuOpen] = useMenuOpenState();
      if (!sessionId?.startsWith(IMPORTED_ID_PREFIX)) return null;
      return h(primitives.MenuItemButton, {
        icon: h(primitives.IconRefreshOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false);
          onSync(sessionId);
        },
      }, 'Sync with MiniMax');
    }

    function createToast() {
      let toast = null;
      let hideTimer = 0;
      let removeTimer = 0;
      return (text, kind = 'info') => {
        if (toast === null) {
          toast = document.createElement('div');
          toast.className = 'mm-sync-toast';
          toast.setAttribute('role', 'status');
          document.body.appendChild(toast);
        }
        clearTimeout(hideTimer);
        clearTimeout(removeTimer);
        toast.dataset.kind = kind;
        toast.textContent = text;
        requestAnimationFrame(() => toast?.setAttribute('data-shown', ''));
        hideTimer = window.setTimeout(() => {
          toast?.removeAttribute('data-shown');
          removeTimer = window.setTimeout(() => {
            toast?.remove();
            toast = null;
          }, 160);
        }, kind === 'error' ? 6200 : 3600);
      };
    }

    function apply(ctx) {
      const showToast = createToast();
      const pending = new Set();
      const sync = async (sessionId) => {
        if (pending.has(sessionId)) return;
        pending.add(sessionId);
        showToast('Finding the matching MiniMax session…');
        try {
          const result = await ctx.connection.rpc.call('/api', 'minimaxSessionSync/sync', { args: { sessionId } });
          if (!result.ok) {
            showToast(failureText(result.error), 'error');
            return;
          }
          const value = result.value;
          if (value.status === 'already-current') showToast(`Already synced with “${value.sourceTitle}”.`);
          else {
            const noun = value.appendedMessages === 1 ? 'message' : 'messages';
            const by = value.matchedBy === 'content' ? ' · matched by content' : '';
            showToast(`Synced ${value.appendedMessages} ${noun} from “${value.sourceTitle}”${by}.`, 'success');
          }
        } catch (error) {
          showToast(`MiniMax sync failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        } finally {
          pending.delete(sessionId);
        }
      };
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = '@local/minimax-session-importer';
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'minimax-session-importer: styles');
      ctx.effect(() => ctx.uiConversation.userText.register(taggedRule));
      ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
        name: 'conversation.user.text.node', key: 'minimax-tagged-data'
      }, TaggedData));
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'minimax-session-importer', order: 20, label: 'Import MiniMax sessions'
      }, (props) => h(Importer, { ...props, remote: ctx.remote })));
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: 'minimax-sync', order: 350, label: 'Sync with MiniMax'
      }, (props) => h(SyncMenuItem, { ...props, onSync: sync })));
    }

    return {
      inject: ['slots', 'connection', 'remote', 'remote.commands', 'remote.session', 'uiConversation'],
      apply,
    };
  },
});
