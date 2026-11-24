# dsh-zoom-call

Turn one DSH session into a **zoom call**: a cast of persona-configured agents
(screenwriter, director, storyboard artist, cinematographer, history scholar,
…) that **you** and the **Lead agent** can both call into the same chat.
Every member has its own system prompt, its own behavior mode template, and its
own **colored chat bubble** — rendered through your existing
[`dsh-chat-bubbles`](../dsh-chat-bubbles) plugin's bubble styling.

You are the Executive Producer. The Lead agent is the Second Executive Producer.
The cast does the specialist work.

```dsh-ui (concept)
 human ⇄ Lead (session agent)
         │  zoom_call / native team tools
         ├── 🎬 film-director      (own system prompt, own inbox, color #…)
         ├── ✍️ screenwriter        …
         ├── 🖍️ storyboard-artist   …
         └── 📜 history-scholar     …
 teammate ⇄ teammate and teammate → lead all run over native
 Agent Teams (ctx.agentTeams): durable inboxes, roster, task board.
```

## How it works

| Concern | Mechanism (all native DSH parts) |
|---|---|
| Who the members are | `.zoom-call.cast.json` in the **session workspace**; seeded with a five-person film crew on first use |
| Their system prompts | a scoped `systemPrompt.section` (`zoom-call:persona`) registered on the teammate Agent — the same section mechanism the native deployment persona uses |
| Their behavior | `modeTemplate` per member (default: a standard call-etiquette mode), appended to that section |
| Calling them in | the 🎥 panel (you) or the `zoom_call` model tool (the Lead) → `ctx.agentTeams.spawnTeammate` |
| You talking to them | panel 💬 → `sendMessage` through the team service, prefixed "From the Executive Producer (human)"; open any teammate's own conversation via the native Agent Teams header panel to chat directly |
| Them answering in your chat | they `send_message` to `lead`; the peer message lands in the Lead's chat tinted with their bubble color |
| Bubble colors | rows with `source.kind === 'agent-message'` get `data-dsh-chat-bubbles`'s own `[data-dsh-chat-bubble]` attribute plus per-member `--dcb-fill / --dcb-edge` overrides; in a called member's own view, its assistant bubbles take its color |
| Permission / model per member | `mode.permission` and `mode.model` fields; applied as the durable `permission/preset` and `model/selection` session events the native subagent overrides use |

## Cast file schema

```jsonc
{
  "version": 1,
  "defaults": { "emoji": "🎭", "model": "" },   // inherited by every member
  "cast": [
    {
      "name": "screenwriter",        // lower-kebab, permanent team name
      "display": "Screenwriter",
      "emoji": "✍️",
      "color": "#e05d7f",
      "systemPrompt": "You own script structure, scenes, dialogue…",
      "modeTemplate": "",             // "" = standard call mode
      "kickoff": "",                  // extra first-message instructions
      "context": "fresh",             // fresh | fork (fork inherits Lead turns)
      "permission": "",               // e.g. "auto" ("" = inherit)
      "model": ""                     // provider/model[/effort] ("" = inherit)
    }
  ],
  "roster": { "<teammate session id>": "screenwriter" }  // maintained by the plugin
}
```

Every field is open; every field has a working standard default. The plugin
writes nothing into DSH itself — the cast file lives in your project.

## Model tool (for the Lead)

`zoom_call` — actions: `list`, `assemble` (target name or `all=true`),
`say`, `status`, `dismiss`. The tool description tells the Lead it is the
Second Executive Producer and should call cast members in rather than
hand-rolling generic teammates.

## Requirements

* DSH with the **experimental Agent Teams** bundle (already in your web
  profile: `@deepseek-ai/dsh-experimental-agent-team-profile`).
* `dsh-chat-bubbles` for the bubble look (optional — colors still apply).
* No npm dependencies: the host half uses string-injected services only, so a
  symlink install is complete.

## Install / uninstall

See [INSTALL.md](INSTALL.md). Short version: run `./install.sh`, restart the
harness **socket-first**, verify; `./uninstall.sh` reverts everything and can
recover a boot blocked by this plugin.

## Known ceilings (ponytail)

* `ctx.agentTeams` is an **experimental** service; the exact call shapes are
  pinned to DSH `0.2.1-rc.2`. A harness update may need a re-check.
* The persona section is attached when the teammate Agent is live in-process;
  after a DSH restart it re-attaches at the member's next status event (the
  durable `roster` map is what makes that possible). The kickoff brief also
  carries the persona as the first message, so behavior survives even before
  the section lands.
* Permission/model events are appended inside `runMaintenance` — they take
  effect from the member's next turn, not mid-turn.
* Human "💬" messages are relayed with the Lead's authority (the team API
  requires a member caller), so teammates see them attributed in the text.
