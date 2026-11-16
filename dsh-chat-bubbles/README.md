# dsh-chat-bubbles

A browser-only DSH plugin: assistant messages have a soft-blue chat bubble and a small **↩ Reply** button. User messages keep their existing appearance.

Click **Reply** to prepend an editable Markdown quote of that specific assistant message to the normal composer, then type and send normally. The quote identifies the original message. Existing draft text, reference chips, and attachments are preserved through DSH's native insertion API. Nothing is sent automatically. Remove the quoted text to cancel a reply; normal composer undo also works. Clicking Reply again adds another quote without deleting the draft.

Assistant prose, Markdown, images, and inline GenUI remain native interactive content. Tool rows, reasoning disclosures, and sidebar conversations are not recolored. Reply reads the latest original assistant content, not rendered button labels or hidden reasoning. Quotes are not truncated. For image-only messages the quote includes `[Image]` and the original message identity.

## Development

The runtime has no dependencies and no generated bundle: `client.js` is already a ModuleLoader browser entry. JSDOM is a test-only dependency.

- `npm install --ignore-scripts` creates the initial dependency lock.
- `make deps` installs from that lock on subsequent checkouts.
- `make test` checks syntax and runs DOM/interaction regression tests.

## Installation and compatibility

Link `@local/dsh-chat-bubbles` into the Web profile, add its local dependency, and enable the bundle with the existing plugin manager. No DSH core changes or service restart are needed on the current live-reload profile. Refresh the existing GUI after activation (a hard refresh also clears immutable cached plugin batches).

The plugin uses the public `sessions`, `uiConversation`, and `conversation.input` services. It decorates the shipped `data-chat-flow-kind="assistant-step"` seat and the native AssistantMarkdown `slot > root > body` structure without moving native content. A different upstream renderer structure may require updating that selector. Decoration scans the loaded main transcript once per DOM frame (O(n) loaded assistant messages); it does not fetch the entire history or impose a message/quote length limit. Disable the plugin to remove styles, attributes, controls, and listeners.

Session, author, and message identities are distinct in the browser decoration. Multi-agent participants, subscriptions, automatic replies, and routing are intentionally **not implemented**; those are future work, not background behavior.
