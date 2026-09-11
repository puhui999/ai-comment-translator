# IDEA bridge for DSH 0.1.5-rc.2

This package adds an IDE connection and a session-local prompt section to the
unchanged official **Web** profile. It neither replaces the DSH UI nor removes
tools, permissions, models, skills, or agent functions.

Release `package.json`, `idea-bridge.mjs` and `idea-client.js` into one directory.
Load the host module with an ordinary profile patch:

```yaml
- insert:
    - id: ide-bridge
      name: /absolute/path/idea-bridge.mjs
```

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
Responses are plain JSON. Errors are non-2xx `{ "error": "message" }`.

| Method and path | Meaning |
| --- | --- |
| `GET /health` | `{ok, protocolVersion, dshVersion}` |
| `GET /state` | `{sessionId, mode, customPrompt, browserConnected, projectDir}` |
| `GET /sessions` | `{items}` from the official controller, filtered to this project |
| `POST /sessions` | Create and navigate; optional `{mode, customPrompt, title}` |
| `POST /mode` | `{mode, customPrompt?, sessionId?}`; omitted session means current, explicit `null` means new-session default |
| `PUT /sessions/ID/mode` | Set the exact session's mode |
| `POST /context` | Atomically resolve current session (create if absent), set optional mode, and enqueue selection |
| `POST /sessions/ID/context` | Enqueue into the exact session |

Context body: `{id?, text, mode?, customPrompt?, prompt?, instruction?, filePath?,
relativePath?, language?, range?, startLine?, endLine?, documentVersion?, unsaved?}`.
Keep `id` and all body fields unchanged for a retry. `range` may contain line,
column, and offset coordinates. Selection text is preserved as a JSON string,
including unsaved edits and code fences. Source limit is 200,000 UTF-16 code units;
JSON request limit is 2 MiB; custom prompt and instruction limits are 16,000
characters each. The result `{sessionId, accepted:true, requestId}` means DSH
accepted the message into its queue, not that model execution has finished.

Mode `general` contributes no additional section, `tutor` contributes the teaching
instructions, and `custom` contributes the user's text. Existing DSH instructions
remain. A mode snapshot lasts for a whole turn; changes apply to subsequent
turns, not the tool-continuation steps of an active turn. Each submitted selection
also freezes its own mode while waiting in the queue, so later submissions do
not alter earlier queued work. Unmarked historical
sessions stay general. Modes and the last 256 selection receipts persist under
the project-owned `DSH_HOME`; a selection's target is reserved before enqueue,
and the stable request ID also uses DSH's durable prompt deduplication.

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
