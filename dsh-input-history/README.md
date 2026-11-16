# dsh-input-history

Shell-style history in the DSH Web GUI chat composer (pure client plugin, no
Host services or network access).

- **↑** in the chat box brings back the previous sent message; repeat to walk
  further back.
- **↓** steps forward; past the newest entry it restores the draft you had
  before starting to recall (normally empty).
- Text you type is never overwritten: recall only starts from an empty draft
  and continues while the recalled text is untouched.
- Up/Down are left alone while a composer menu (slash/command list, model
  picker) is open.

History is read live from the Session's loaded event window
(`sessions.binding(id).eventSource`): human `user/message` events, newest
first. Nothing is recorded at send time, so Sessions that already existed
before the plugin was installed work immediately. Injected context, tool
traffic and image-only messages are skipped.

## Install (web profile)

1. Add the bundle to `~/.dsh/profiles/web/package.json`:
   - dependency `"@local/dsh-input-history": "link:<this directory>"`;
   - `"@local/dsh-input-history"` in `dsh.profile.bundles`.
2. Link it: `ln -s <this directory> ~/.dsh/profiles/web/node_modules/@local/dsh-input-history`.
3. Restart the Web host so the profile tree reloads:
   `systemctl --user restart deepseek-harness.service`.

## Limits

- Web GUI only; the composer is the shipped Lexical contenteditable
  (`[data-composer-input]`).
- Only the loaded history window is searched. The newest messages are always
  loaded; older ones appear after the transcript pages back in.
- Recalled text is the durable model-facing text of the prompt. Prompt
  references (file/agent chips) were expanded when the message was sent, so a
  recalled message shows that expanded text rather than the original chip
  tokens.
