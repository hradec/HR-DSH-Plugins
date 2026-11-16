/**
 * dsh-input-history — ↑/↓ recall of previously sent text in the chat composer.
 *
 * Pure client plugin: one capture-phase key listener scoped to the chat
 * composer. History is the Session's complete list of human prompts, paged
 * from the durable log through the ordinary `remote.session.page` read
 * (the same cold-safe page endpoint the transcript uses), so Sessions that
 * existed before the plugin work too and the recall list is not limited to
 * the transcript's loaded window. Recall writes the draft through the public
 * conversation input face (`conversation.input.for`), keeping the composer's
 * editor as the single source of truth.
 *
 * ponytail: the whole prompt list is fetched once per session revision and
 * cached; pages are capped (see MAX_PAGES) so a pathological log cannot stall
 * the composer. Only the newest prompts of a very long session are kept when
 * the cap is hit.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-input-history',
  factory() {
    const COMPOSER = '[data-composer-input]'
    // Open composer menus own Up/Down while they are visible.
    const OPEN_MENU = '[data-trigger-menu],[data-composer-card] [role="listbox"],[data-composer-card] [role="menu"]'
    const PAGE_MESSAGES = 500
    const MAX_PAGES = 10

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      // One recall walk: `prompts` newest first, `index` is the current entry,
      // `draft`/`written` are what the composer showed after our setDraft, and
      // `stash` is the draft restored when stepping forward past the newest.
      let recall = null
      // Session prompt list cache: refetched when the visible log tail changes.
      let cache = { id: undefined, seq: undefined, prompts: [] }
      let loading = null

      /** Session shown in the main view, matching the shipped Workspace selection. */
      function currentSessionId() {
        const list = ctx.sessions.list.getSnapshot()
        const byId = list?.byId
        if (byId === undefined) return undefined
        for (const row of Object.values(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id
        }
        return undefined
      }

      /** Session id, its resident input facade, and its loaded event source. */
      function currentInput() {
        const id = currentSessionId()
        if (id === undefined) return undefined
        const binding = ctx.sessions.binding(id)
        if (binding === undefined) return undefined
        let facade
        try {
          facade = ctx.conversation.input.for(binding.ctx)
        } catch {
          /* the session generation ended between the catalogue read and here */
          return undefined
        }
        return { id, facade, binding }
      }

      /** Newest durable seq in the loaded window (the remote page cut). */
      function latestSeq(binding) {
        const entries = binding.eventSource.getSnapshot().entries
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index]
          if (entry.type === 'event') return entry.event.seq
        }
        return undefined
      }

      /** Prompt text of one human `user/message` event, or undefined. */
      function promptText(event) {
        if (event.type !== 'user/message') return undefined
        if (event.data.source?.kind !== 'user') return undefined
        const text = event.data.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        return text.trim() === '' ? undefined : text
      }

      /** Append one chronological page's prompts, newest first. */
      function collect(records, prompts) {
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const text = promptText(records[index].event)
          if (text !== undefined) prompts.push(text)
        }
      }

      /** Consecutive repeats add nothing to a history walk. */
      function dedupe(prompts) {
        return prompts.filter((text, index) => index === 0 || prompts[index - 1] !== text)
      }

      /** Fallback when the page read fails: what the loaded transcript has. */
      function readLoaded(binding) {
        const prompts = []
        collect(binding.eventSource.getSnapshot().entries, prompts)
        return dedupe(prompts)
      }

      /** Durable address of the session behind the composer. */
      function addressOf(id) {
        const subagent = ctx.sessions.subagentAddress?.(id)
        return subagent === undefined ? { kind: 'session', sessionId: id } : { kind: 'subagent', ...subagent }
      }

      /** Page the durable log backwards and return every human prompt, newest first. */
      async function fetchPrompts(id, throughSeq) {
        const address = addressOf(id)
        const prompts = []
        let beforeSeq
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const controller = new AbortController()
          const result = await ctx.remote.session.page({
            address,
            throughSeq,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            maxMessages: PAGE_MESSAGES,
          }, controller.signal)
          if (!result.ok) throw new Error(`history page failed: ${result.error.code}`)
          collect(result.value.records, prompts)
          if (!result.value.hasMore) break
          const first = result.value.records[0]?.event.seq
          if (first === undefined || first === 0) break
          beforeSeq = first
        }
        return dedupe(prompts)
      }

      /** Cached prompt list for one session revision, with loaded-window fallback. */
      async function historyOf(current, seq) {
        if (cache.id === current.id && cache.seq === seq) return cache.prompts
        let prompts
        if (seq === undefined) {
          prompts = readLoaded(current.binding)
        } else {
          try {
            prompts = await fetchPrompts(current.id, seq)
          } catch {
            prompts = readLoaded(current.binding)
          }
        }
        cache = { id: current.id, seq, prompts }
        return prompts
      }

      /** Write one recalled prompt and remember exactly what the composer shows. */
      function applyRecalled(facade, next, text) {
        next.written = text
        facade.setDraft(text)
        next.draft = facade.state.getSnapshot().draft
      }

      /** Begin a walk at the newest prompt. */
      function startRecall(current, prompts, stash) {
        if (prompts.length === 0) return
        recall = { id: current.id, prompts, index: 0, stash, draft: '', written: prompts[0] }
        applyRecalled(current.facade, recall, prompts[0])
      }

      function isCycling(state) {
        return recall !== null && (state.draft === recall.draft || state.draft === recall.written)
      }

      function recallOlder(event) {
        const current = currentInput()
        if (current === undefined) return
        const state = current.facade.state.getSnapshot()
        if (state.phase !== 'plain') return
        if (recall !== null && recall.id !== current.id) recall = null
        // Never overwrite text the user typed; only an empty (or untouched
        // recalled) draft steps through history.
        if (!isCycling(state) && state.draft.trim() !== '') return

        if (isCycling(state)) {
          const text = recall.prompts[recall.index + 1]
          if (text === undefined) return
          event.preventDefault()
          event.stopPropagation()
          recall.index += 1
          applyRecalled(current.facade, recall, text)
          return
        }

        // Starting a walk: the newest prompt may already be cached, or the
        // durable log has to be paged first.
        if (current.binding.session.getSnapshot().blank === true) return
        const seq = latestSeq(current.binding)
        if (cache.id === current.id && cache.seq === seq) {
          if (cache.prompts.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          startRecall(current, cache.prompts, state.draft)
          return
        }
        if (loading !== null && loading.id === current.id) return
        event.preventDefault()
        event.stopPropagation()
        const token = {}
        loading = { id: current.id, token }
        historyOf(current, seq).then((prompts) => {
          if (loading === null || loading.token !== token) return
          loading = null
          const now = currentInput()
          if (now === undefined || now.id !== current.id || recall !== null) return
          const snapshot = now.facade.state.getSnapshot()
          if (snapshot.phase !== 'plain' || snapshot.draft.trim() !== '') return
          startRecall(now, prompts, snapshot.draft)
        }, () => {
          if (loading !== null && loading.token === token) loading = null
        })
      }

      function recallNewer(event) {
        if (recall === null) return
        const current = currentInput()
        if (current === undefined || current.id !== recall.id) {
          recall = null
          return
        }
        const state = current.facade.state.getSnapshot()
        if (state.phase !== 'plain' || !isCycling(state)) {
          recall = null
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (recall.index === 0) {
          const stash = recall.stash
          recall = null
          current.facade.setDraft(stash)
          return
        }
        recall.index -= 1
        applyRecalled(current.facade, recall, recall.prompts[recall.index])
      }

      function onKeyDown(event) {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
        const target = event.target
        if (!(target instanceof Element) || target.closest(COMPOSER) === null) return
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (document.querySelector(OPEN_MENU) !== null) return
        if (event.key === 'ArrowUp') recallOlder(event)
        else if (event.key === 'ArrowDown') recallNewer(event)
      }

      ctx.effect(() => {
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, 'dsh-input-history: composer listener')
    }

    return {
      inject: ['sessions', 'conversation', 'remote', 'remote.session'],
      apply,
    }
  },
})
