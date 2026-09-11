# IDEA bridge for DSH 0.1.5-rc.2

This package adds an IDE connection, a session-local prompt section and mode-bound skills to the
official **Web** profile. It neither replaces the DSH conversation UI nor removes
tools, permissions, models, skills, or agent functions.

Release `package.json`, `idea-bridge.mjs`, `idea-client.js` and
`skills/code-tutor/SKILL.md` into one directory, preserving the skill subdirectory.
Load the host module with an ordinary profile patch:

```yaml
- insert:
    - id: ide-bridge
      name: /absolute/path/idea-bridge.mjs
```

The IDEA launcher also disables `@deepseek-ai/dsh-host-directory-picker-auto`
and inserts the official `@deepseek-ai/dsh-host-directory-picker-browse` and
`@deepseek-ai/dsh-client-ui-directory-picker-browse` pair, keeping directory
selection inside JCEF. The host registers the owning project as a workspace;
the native Client controls opening or reusing its blank conversation.

Launch with a supported Node runtime and an exact `@deepseek-ai/dsh@0.1.5-rc.2`:

```text
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --patch ide.patch.yml --no-open --port 0
```

Required environment: `DSH_HOME`, `DSH_IDE_PROJECT_DIR`, and
`DSH_IDE_BRIDGE_TOKEN` (at least 32 characters; the IDE generates 256 random bits).
The startup record contains no credential:

```text
DSH_IDE_BRIDGE_READY {"endpoint":"http://127.0.0.1:PORT"}
```

Wait for both that record and the official `dsh web: URL` before publishing IDE
readiness. Only the official authenticated Web URL is loaded in JCEF. The
private bridge accepts a bearer token over loopback and refuses browser Origin
headers. Its Client half uses the official browser-cookie authorization on a
separate, same-origin `/ide-dsh/browser` route.

## IDE HTTP contract (version 1)

Every request includes `Authorization: Bearer TOKEN`; body requests are JSON.
Responses are plain JSON. Errors are non-2xx `{ "error": "message", "code"?: "..." }`.
An explicitly cancelled selection returns HTTP 409 with `code:"selection-canceled"`.

| Method and path | Meaning |
| --- | --- |
| `GET /health` | `{ok, protocolVersion, dshVersion}` |
| `GET /state` | `{sessionId, mode, customPrompt, skillNames, customMode, browserConnected, projectDir, appearance, status}` |
| `GET /sessions` | `{items}` from the official controller, filtered to this project |
| `POST /sessions` | Create and navigate; optional `{mode, customPrompt, skillNames, title}` |
| `POST /mode` | `{mode, customPrompt?, skillNames?, sessionId?}`; omitted session means current, explicit `null` means new-session default |
| `PUT /sessions/ID/mode` | Set the exact session's mode |
| `POST /context` | Enqueue into the supplied session; explicit `null` creates a session, omission uses the current session for older clients |
| `POST /sessions/ID/context` | Enqueue into the exact session |
| `POST /ide/state` | Publish the IDE's current `appearance` and/or delivery `status` |
| `GET /ide/commands` | Drain `{commands:[{id,action}]}` requested by the embedded workbench |

The browser uses the cookie-authenticated `POST /ide-dsh/action` route for mode
selection and native IDE commands. Mode actions explicitly carry a session ID
or `null` for the new-session default. `settings`, `restart`, and `retry` are the
only native command names; no executable, file path, or arbitrary script is
accepted. `action:"skills"` reads the exact session's available, user-invocable
skill catalog; `action:"mode-config"` reads its saved custom configuration.
Both require an explicit `sessionId` or `null` and never create a conversation.
The queue holds at most 32 outstanding commands. Appearance is an IDE
boolean `dark` and five validated `#RRGGBB` values (`background`, `foreground`,
`muted`, `border`, `accent`). A delivery status is `{message,kind,queued}`, with
`kind` one of `idle`, `busy`, `success`, or `error`. Both are returned with browser
heartbeats so the native DSH Client extension can use the original theme runtime
and UI slots. They are ephemeral and do not rewrite saved conversation modes.

Context body: `{id?, text, sessionId?, mode?, customPrompt?, skillNames?, prompt?, instruction?, filePath?,
relativePath?, language?, range?, startLine?, endLine?, documentVersion?, unsaved?}`.
Keep `id` and all body fields unchanged for a retry. `range` may contain line,
column, and offset coordinates. The native DSH user bubble renders plain text:
selection text retains its exact line breaks and indentation, with concise file,
range, version and unsaved-state lines. No HTML, JSON or Markdown wrapper is
added. Source limit is 200,000 UTF-16 code units;
JSON request limit is 2 MiB; custom prompt and instruction limits are 16,000
characters each. The result `{sessionId, accepted:true, requestId}` means DSH
accepted the message into its queue, not that model execution has finished.

Mode `general` forces no additional skill, `tutor` binds the bundled
`ide-code-tutor`, and `custom` uses a role prompt and/or at most 8 selected skills.
The native skill registry resolves names against the actual project and agent
scope. The official skill renderer and pre-step message mechanism load their
instructions; missing or disabled bindings produce an error instead of silently
falling back. Existing DSH instructions and explicit skill invocations remain.
A small current-mode declaration scopes automatic bindings to the current turn;
old materials stay in history without being declared the next turn's mode.
The persisted `customMode` template survives switching away and restarting.
A mode snapshot lasts for a whole turn; changes apply to subsequent
turns, not the tool-continuation steps of an active turn. Each submitted selection
also freezes its own mode and resolved skill content while waiting in the queue, so later submissions do
not alter earlier queued work. A native blank session inherits the default once,
including its remembered custom template; initialization and permission events
do not make it nonblank. Unmarked sessions with a previous turn stay general.
Modes and the last 256 selection receipts persist under
the project-owned `DSH_HOME`; a selection's target is reserved before enqueue,
and the stable request ID also uses DSH's durable prompt deduplication.
DSH's graceful disposal cancels its unclaimed inbox. The bridge preserves that
native behavior and does not replay cancelled tasks. Repeating a cancelled
receipt must fail explicitly rather than returning a stale accepted result;
the user can submit a new selection with a new request ID.

IDE-managed project homes and extracted bridge resources live under the IDE
configuration directory, while npm runtime packages stay under its system cache.
Legacy project homes are copied into a private staging directory and published
only if no stable home exists; the original is retained. Managed npm installs
are reused only with a completion marker and matching package manifest/entry,
all checked under the installation lock.

Current selection is observed through the native `ctx.sessions.list` service;
navigation uses `ctx.uiWorkspace.openSession`. No DOM scraping or invented
session URL is used. The browser heartbeat marks disconnect after five seconds.

## Local integration check

From the repository root:

```sh
npm install --prefix /tmp/dsh-agent-dev-runtime --no-audit --no-fund @deepseek-ai/dsh@0.1.5-rc.2
node scripts/dsh-agent-integration.mjs
```

The check boots the published full Web profile against a local streaming fixture,
checks authentication and the client boot graph, sends unsaved code, exercises a
real `read` tool round trip, and checks additive modes and per-turn mode stability.
`DSH_TEST_RUNTIME` overrides the npm installation prefix. `DSH_TEST_KEEP=1` keeps
the passing fixture alive and writes its private connection details under its
temporary DSH home. `node scripts/dsh-fake-model.mjs` runs the standalone fixture;
use its printed base URL as `DEEPSEEK_BASE_URL` and `local-fixture-key` as
`DEEPSEEK_API_KEY` in a sandbox launch.
