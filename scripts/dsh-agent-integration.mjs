/** Integration against the published, unchanged DSH Web runtime and a local model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { startFakeModel } from './dsh-fake-model.mjs';

const home = await mkdtemp(join(tmpdir(), 'idea-dsh-integration-'));
const projectDir = await mkdtemp(join(tmpdir(), 'idea-dsh-project-'));
const skillFile = name => join(projectDir, '.dsh', 'skills', name, 'SKILL.md');
const writeSkill = async (name, marker, extra = '') => {
  await mkdir(join(skillFile(name), '..'), { recursive: true });
  await writeFile(skillFile(name), `---\nname: ${name}\ndescription: Local integration fixture ${name}\n${extra}---\n\n${marker}\nUse this fixture only when explicitly selected.\n`);
};
await writeSkill('integration-skill-a', 'SKILL_A_ORIGINAL');
await writeSkill('integration-skill-b', 'SKILL_B_ORIGINAL', 'disable-model-invocation: true\n');
await writeSkill('integration-hidden', 'HIDDEN_SKILL', 'user-invocable: false\n');
const resource = fileURLToPath(new URL('../idea-plugin/src/main/resources/dsh/idea-bridge.mjs', import.meta.url));
// Exercise the browser race: switching sessions during an in-flight poll must
// immediately publish the new selection without waiting for the next interval.
{
  let plugin; let subscriber; let release; let selected = 'session-a';
  const posted = []; const disposers = []; const slots = []; const overrides = [];
  let preference = 'light';
  const clientAppearance = { dark: true, background: '#242428', foreground: '#E7E7EA', muted: '#A8A8AD', border: '#45454A', accent: '#589DF6' };
  // Render-only components are not mounted by this protocol test. The real
  // DSH boot below still resolves the actual React and primitives packages.
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  };
  const primitives = new Proxy({}, { get: (_target, name) => function Primitive() { return name; } });
  runInNewContext(await readFile(join(resource, '../idea-client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => {
      if (name === 'react') return react;
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
      throw new Error(`Unexpected client dependency: ${name}`);
    }); } } },
    crypto: { randomUUID: () => 'client-test' }, AbortController, console, queueMicrotask,
    setInterval: () => 1, clearInterval: () => {},
    fetch: async (_url, options) => {
      posted.push(JSON.parse(options.body));
      if (posted.length === 1) await new Promise(done => { release = done; });
      return { ok: true, json: async () => ({ sessionId: selected, mode: 'tutor', customPrompt: '', appearance: clientAppearance, status: { message: '', kind: 'idle', queued: 0 } }) };
    },
  });
  plugin.apply({
    sessions: { list: { getSnapshot: () => ({ current: selected }), subscribe: listener => { subscriber = listener; return () => {}; } } },
    uiWorkspace: { openSession: () => {} }, effect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); },
    slots: { inject: (_name, register) => register(), register: (definition, component) => { slots.push({ definition, component }); return () => {}; } },
    on: () => () => {},
    theme: {
      overrideTokens: (source, tokens) => { overrides.push({ source, tokens }); return () => {}; },
      setTheme: value => { preference = value; },
      getTheme: () => ({ preference, active: { id: preference, colorScheme: preference, tokens: {} } }),
    },
  });
  selected = 'session-b'; subscriber(); release();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(posted.map(item => item.sessionId), ['session-a', 'session-b']);
  assert.ok(slots.some(slot => slot.definition.name === 'conversation.input.left'), 'Mode control contributes to the native composer slot');
  assert.ok(slots.some(slot => slot.definition.name === 'sidebar.footer.action'), 'IDE actions contribute to the native sidebar slot');
  assert.ok(overrides.length > 0, 'IDE colors are applied through the native theme service');
  assert.equal(preference, 'dark');
  for (const { tokens } of overrides) for (const value of Object.values(tokens)) {
    assert.equal(typeof value.light, 'string'); assert.equal(typeof value.dark, 'string');
  }
  for (const dispose of disposers.reverse()) dispose();
}
const token = randomBytes(32).toString('hex');
const toolPath = join(projectDir, 'learning.ts');
await writeFile(toolPath, 'export const IDE_READ_PROOF = 42;\n');
const model = await startFakeModel({ recordPath: join(home, 'model-requests.jsonl'), delayMs: 50, toolTestPath: toolPath });
const patch = join(home, 'ide.patch.yml');
await writeFile(patch, `- id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'\n  disabled: true\n- insert:\n    - id: ide-directory-picker-host\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: ide-directory-picker-ui\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'\n    - id: ide-bridge\n      name: ${JSON.stringify(resource)}\n`);
const executable = join(process.env.DSH_TEST_RUNTIME ?? '/tmp/dsh-agent-dev-runtime', 'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.equal(JSON.parse(await readFile(join(executable, '../../package.json'), 'utf8')).version, '0.1.5-rc.2');
let output = ''; let errors = ''; let endpoint; let webUrl;
let processHandle;
function startRuntime() {
  output = ''; errors = ''; endpoint = undefined; webUrl = undefined;
  processHandle = spawn(process.execPath, [executable, '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: projectDir,
    env: { ...process.env, DSH_HOME: home, DSH_IDE_PROJECT_DIR: projectDir, DSH_IDE_BRIDGE_TOKEN: token,
      DEEPSEEK_API_KEY: 'local-fixture-key', DEEPSEEK_BASE_URL: model.baseURL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processHandle.stdout.on('data', chunk => {
    output += chunk.toString();
    endpoint = output.match(/DSH_IDE_BRIDGE_READY (\{[^\n]+\})/)?.[1];
    webUrl = output.match(/dsh web: (http:\/\/\S+)/)?.[1];
  });
  processHandle.stderr.on('data', chunk => { errors += chunk.toString(); });
}
async function stopRuntime() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const child = processHandle;
  await new Promise(done => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('close', () => { clearTimeout(kill); done(); });
    child.kill('SIGTERM');
  });
}
startRuntime();
const diagnostics = () => `${errors}\n${output}`.replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]');
async function until(test, label, ms = 45000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return;
    if (processHandle.exitCode !== null) throw new Error(`DSH exited ${processHandle.exitCode}: ${diagnostics()}`);
    await new Promise(done => setTimeout(done, 80));
  }
  throw new Error(`${label} timed out\n${diagnostics()}`);
}
let keep = false;
try {
  await until(() => endpoint && webUrl, 'Real DSH Web boot');
  endpoint = JSON.parse(endpoint).endpoint;
  const call = async (path, body, method = body ? 'POST' : 'GET', extra = {}) => {
    const response = await fetch(endpoint + path, { method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
  assert.equal((await fetch(endpoint + '/health')).status, 401);
  assert.equal((await fetch(endpoint + '/health', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } })).status, 403);
  const foreignHostStatus = await new Promise((accept, reject) => {
    const request = httpRequest(endpoint + '/health', { headers: { Authorization: `Bearer ${token}`, Host: 'attacker.invalid' } }, response => {
      response.resume(); response.once('end', () => accept(response.statusCode));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(foreignHostStatus, 403);
  const rejected = async (value, status) => {
    const response = await fetch(endpoint + '/context', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, status, await response.text());
  };
  await rejected({ text: 'x'.repeat(200001) }, 413);
  await rejected({ text: 'small', extra: 'x'.repeat(2 * 1024 * 1024) }, 413);
  assert.equal((await call('/health')).dshVersion, '0.1.5-rc.2');
  const exchange = await fetch(webUrl, { redirect: 'manual' });
  assert.equal(exchange.status, 303);
  let cookie = exchange.headers.get('set-cookie').split(';', 1)[0];
  let origin = new URL(webUrl).origin;
  const html = await (await fetch(origin, { headers: { cookie } })).text();
  assert.ok(html.includes('@translate/idea-dsh-bridge'), 'IDE client joins the official full boot graph');
  assert.ok(html.includes('@deepseek-ai/dsh-client-ui-directory-picker-browse'), 'The IDE uses the official browser directory picker');
  assert.ok(!html.includes('@deepseek-ai/dsh-client-ui-directory-picker-native'), 'The IDE avoids hidden system directory dialogs');
  assert.equal((await call('/sessions')).items.length, 0, 'Starting the IDE Host does not create a conversation');
  const workspaceCheck = await fetch(origin + '/api/workspace/create', {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'initial-project-workspace', method: 'workspace/create', payload: { args: { request: { path: projectDir } } } }),
  });
  const workspaceResult = (await workspaceCheck.json()).result;
  assert.equal(workspaceResult.ok, true, JSON.stringify(workspaceResult));
  assert.equal(workspaceResult.value.created, false, 'The native workspace API already knows the owning IDE project on a fresh profile');
  assert.equal((await call('/sessions')).items.length, 0);
  const created = await call('/sessions', { mode: 'tutor' });
  const id = created.sessionId;
  assert.equal((await call('/sessions')).items.some(item => item.sessionId === id), true);
  assert.deepEqual(created.skillNames, ['ide-code-tutor']);
  // The native DSH controls use the official same-origin browser cookie. IDE
  // appearance/status and lifecycle commands use the separately authenticated
  // process bridge; neither channel may accidentally inherit the other's auth.
  const browserRequest = async (path, value, { includeCookie = true, requestOrigin = origin, status = 200 } = {}) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(includeCookie ? { cookie } : {}), ...(requestOrigin ? { origin: requestOrigin } : {}) },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
  // The same published unary Remote used by the native DSH conversation.
  // This path deliberately bypasses the IDE selection admission checks.
  const nativePrompt = async (requestId, sessionId, text) => {
    const envelope = await browserRequest('/api/session/prompt', {
      type: 'client-request', rpcId: requestId, method: 'session/prompt',
      payload: { args: { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] } } },
    });
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  const nativeCreate = async request => {
    const envelope = await browserRequest('/api/session/create', {
      type: 'client-request', rpcId: `native-create-${randomBytes(6).toString('hex')}`, method: 'session/create',
      payload: { args: { request } },
    });
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value.sessionId;
  };
  const nativeEvents = async sessionId => {
    const summary = (await call('/sessions')).items.find(item => item.sessionId === sessionId);
    const envelope = await browserRequest('/api/session/page', {
      type: 'client-request', rpcId: `native-page-${sessionId}`, method: 'session/page',
      payload: { args: { request: { address: { kind: 'session', sessionId }, throughSeq: summary.projections.asOfSeq } } },
    });
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value.records.map(record => record.event);
  };
  const nativeQueue = async sessionId => {
    const WebSocket = createRequire(executable)('ws');
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie, origin } });
    try {
      return await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error('Native queue baseline timed out')), 5000);
        const finish = (error, value) => { clearTimeout(timeout); error ? reject(error) : accept(value); };
        socket.on('error', error => finish(error));
        socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'integration-control', endpoint: 'session/control', payload: { args: {} } })));
        socket.on('message', bytes => {
          const frame = JSON.parse(bytes.toString());
          if (frame.type === 'error') finish(new Error(JSON.stringify(frame.error)));
          if (frame.type === 'item' && frame.value.type === 'baseline') finish(null, frame.value.value.queues[sessionId] ?? []);
        });
      });
    } finally { socket.close(); }
  };
  await browserRequest('/ide-dsh/action', { action: 'settings' }, { includeCookie: false, status: 401 });
  await browserRequest('/ide-dsh/action', { action: 'settings' }, { requestOrigin: 'https://attacker.invalid', status: 403 });
  await browserRequest('/ide-dsh/action', { action: 'evaluate', code: 'alert(1)' }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', mode: 'general' }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: '', mode: 'general' }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: 'missing-session', mode: 'general' }, { status: 404 });
  const sessionCount = (await call('/sessions')).items.length;
  const available = await browserRequest('/ide-dsh/action', { action: 'skills', sessionId: null });
  assert.equal((await call('/sessions')).items.length, sessionCount, 'Reading the default skill catalog does not create a session');
  assert.ok(available.items.some(item => item.name === 'ide-code-tutor'));
  assert.ok(available.items.some(item => item.name === 'integration-skill-a'));
  assert.ok(available.items.some(item => item.name === 'integration-skill-b' && item.modelInvocable === false && item.userInvocable === true), 'Explicit bindings may use user-invocable skills hidden from model invocation');
  assert.ok(!available.items.some(item => item.name === 'integration-hidden'));
  await browserRequest('/ide-dsh/action', { action: 'skills', sessionId: 'missing-session' }, { status: 404 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom', customPrompt: '', skillNames: [] }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom', customPrompt: '', skillNames: ['missing-skill'] }, { status: 409 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom', customPrompt: '', skillNames: ['integration-hidden'] }, { status: 409 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom', customPrompt: 'many', skillNames: Array.from({ length: 9 }, (_, index) => `skill-${index}`) }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom', customPrompt: '', skillNames: ['integration-skill-b'] });
  const skillOnly = await call('/state');
  assert.equal(skillOnly.customPrompt, '');
  assert.deepEqual(skillOnly.skillNames, ['integration-skill-b']);
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'tutor' });
  assert.deepEqual((await call('/ide/commands')).commands, [], 'Rejected browser actions do not create IDE commands');
  const other = await call('/sessions', { mode: 'general', title: 'Protocol isolation' });
  let browser = await browserRequest('/ide-dsh/browser', { clientId: 'integration', sessionId: null, navigationRevision: 0 });
  const browserRevision = browser.navigation.revision;
  browser = await browserRequest('/ide-dsh/browser', { clientId: 'integration', sessionId: id, navigationRevision: browserRevision });
  assert.equal(browser.sessionId, id);
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: other.sessionId, mode: 'custom', customPrompt: 'OTHER_SESSION_MODE' });
  assert.equal((await call('/state')).mode, 'tutor', 'Native mode changes target the supplied session, not the latest selected one');
  browser = await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: null, mode: 'general' });
  assert.equal(browser.mode, 'tutor', 'An explicit null mode target changes only the new-session default');
  browser = await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom', customPrompt: 'NATIVE_CONTROL_MODE' });
  assert.equal(browser.customPrompt, 'NATIVE_CONTROL_MODE');
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'tutor' });
  const appearance = { dark: true, background: '#242428', foreground: '#E7e7EA', muted: '#a8A8Ad', border: '#45454A', accent: '#589DF6' };
  const nativeStatus = { message: 'IDE selection is queued', kind: 'busy', queued: 2 };
  await call('/ide/state', { appearance, status: nativeStatus });
  browser = await browserRequest('/ide-dsh/browser', { clientId: 'integration', sessionId: id, navigationRevision: browserRevision });
  assert.deepEqual(browser.appearance, appearance);
  assert.deepEqual(browser.status, nativeStatus);
  const nextStatus = { message: 'Ready', kind: 'success', queued: 0 };
  await call('/ide/state', { status: nextStatus });
  browser = await browserRequest('/ide-dsh/browser', { clientId: 'integration', sessionId: id, navigationRevision: browserRevision });
  assert.deepEqual(browser.appearance, appearance, 'A partial status update retains IDE colors');
  assert.deepEqual(browser.status, nextStatus);
  for (const invalid of [
    { appearance: { ...appearance, background: 'url(https://attacker.invalid)' } },
    { appearance: { dark: true } },
    { status: { ...nextStatus, queued: -1 } },
    { status: { ...nextStatus, queued: 10001 } },
    { status: { ...nextStatus, queued: 0.5 } },
    { status: { ...nextStatus, message: 'x'.repeat(301) } },
    { status: { ...nextStatus, kind: 'execute' } },
  ]) {
    const response = await fetch(endpoint + '/ide/state', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(invalid) });
    assert.equal(response.status, 400, await response.text());
  }
  const commandReceipts = [];
  for (const action of ['settings', 'restart', 'retry']) {
    const receipt = await browserRequest('/ide-dsh/action', { action });
    assert.equal(receipt.accepted, true);
    assert.equal(typeof receipt.id, 'string');
    commandReceipts.push({ id: receipt.id, action });
  }
  assert.equal(new Set(commandReceipts.map(item => item.id)).size, 3);
  assert.deepEqual((await call('/ide/commands')).commands, commandReceipts, 'Native commands preserve their exact allowlisted actions and order');
  assert.deepEqual((await call('/ide/commands')).commands, [], 'Commands are drained exactly once');
  for (let index = 0; index < 32; index++) await browserRequest('/ide-dsh/action', { action: 'settings' });
  await browserRequest('/ide-dsh/action', { action: 'settings' }, { status: 429 });
  assert.equal((await call('/ide/commands')).commands.length, 32, 'A full command queue refuses overflow without losing admitted commands');
  assert.deepEqual((await call('/ide/commands')).commands, []);
  await call('/mode', { mode: 'custom', customPrompt: 'FUTURE_SESSION_DEFAULT', sessionId: null });
  assert.equal((await call('/state')).mode, 'tutor', 'Default changes cannot rewrite the selected session');
  const selectionText = 'const answer = 42;\n// 中文注释：这是尚未保存的代码\nconst markdown = "```";\n';
  const selection = { id: 'integration-selection', text: selectionText, mode: 'tutor', prompt: 'IDE_TOOL_TEST: read the original file and explain the selection.', filePath: join(projectDir, 'learning.ts'), relativePath: 'learning.ts', language: 'typescript', unsaved: true,
    range: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 1, startOffset: 0, endOffset: selectionText.length }, documentVersion: 3 };
  const sent = await call('/context', selection);
  assert.equal(sent.accepted, true);
  assert.deepEqual(await call('/context', selection), sent, 'retry is idempotent');
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('const answer = 42;')), 'Model received IDE selection');
  const request = model.requests.find(request => JSON.stringify(request.messages).includes('const answer = 42;'));
  const selectionMessage = request.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(selectionText));
  assert.ok(selectionMessage, 'Multiline Chinese source and embedded code fences reach the model without escaping or truncation');
  const selectionHeader = selectionMessage.content.replace(selectionText, '');
  assert.ok(selectionHeader.includes('未保存的编辑器内容'), 'The selected source retains its unsaved-document state');
  for (const metadata of [`文件：${selection.filePath}`, '项目路径：learning.ts', 'typescript', '第 1:1–4:1 行', '文档版本 3', `字符偏移 0–${selectionText.length}`]) {
    assert.ok(selectionHeader.includes(metadata), `Selection metadata remains readable: ${metadata}`);
  }
  assert.ok(!/<details>|<summary>|```|"unsaved"\s*:/.test(selectionHeader), 'The source is sent as readable plain text without generated HTML, Markdown fences, or JSON metadata');
  const tutorInstructions = request.messages.filter(message => typeof message.content === 'string' && message.content.includes('<skill_content name="ide-code-tutor">'));
  assert.equal(tutorInstructions.length, 1, 'Tutor mode deterministically loads the real built-in skill once');
  assert.ok(tutorInstructions[0].content.includes('# Code tutor'));
  assert.ok(tutorInstructions[0].content.includes('skills/code-tutor'), 'Native skill rendering retains the absolute resource base');
  const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('programming learning assistant'), 'Additive tutor prompt reached the real adapter');
  assert.equal(request.tools.length, 27, 'The pinned full Web profile keeps all 27 standard tools');
  await call('/mode', { mode: 'custom', customPrompt: 'CUSTOM_IDE_TEST_MODE' });
  await until(() => model.requests.some(request => request.messages.some(message => message.role === 'tool' && String(message.content).includes('IDE_READ_PROOF'))), 'Real DSH read tool result');
  const continued = model.requests.find(request => request.messages.some(message => message.role === 'tool' && String(message.content).includes('IDE_READ_PROOF')));
  const continuedSystem = continued.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(continuedSystem.includes('programming learning assistant'));
  assert.ok(!continuedSystem.includes('CUSTOM_IDE_TEST_MODE'), 'A mode change cannot alter later steps of an active turn');
  assert.equal(continued.messages.filter(message => typeof message.content === 'string' && message.content.includes('<skill_content name="ide-code-tutor">')).length, 1, 'A tool continuation retains one skill injection instead of appending another copy');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'First turn idle');
  await call('/context', { id: 'integration-custom', text: 'function second() {}' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('CUSTOM_IDE_TEST_MODE')), 'Next turn custom prompt');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'Second turn idle');
  await call('/mode', { sessionId: id, mode: 'general' });
  await call('/context', { id: 'integration-general', sessionId: id, text: 'GENERAL_MODE_SELECTION' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('GENERAL_MODE_SELECTION')), 'General mode request');
  const general = model.requests.find(request => JSON.stringify(request.messages).includes('GENERAL_MODE_SELECTION'));
  const generalSystem = general.messages.findLast(message => message.role === 'system').content;
  assert.ok(!generalSystem.includes('programming learning assistant') && !generalSystem.includes('CUSTOM_IDE_TEST_MODE'));
  assert.deepEqual(general.tools, request.tools, 'Switching modes preserves the complete tool schemas');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'General turn idle');
  await call('/context', { id: 'integration-queue-hold', text: 'QUEUE_HOLD_SELECTED', mode: 'general' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('QUEUE_HOLD_SELECTED')), 'Queue hold starts');
  await call('/context', { id: 'integration-queue-a', text: 'QUEUE_A_SELECTED', mode: 'custom', customPrompt: 'QUEUE_MODE_A', skillNames: ['integration-skill-a'] });
  await call('/context', { id: 'integration-queue-b', text: 'QUEUE_B_SELECTED', mode: 'custom', customPrompt: 'QUEUE_MODE_B', skillNames: ['integration-skill-b'] });
  await writeSkill('integration-skill-a', 'SKILL_A_CHANGED_AFTER_ADMISSION');
  await writeSkill('integration-skill-b', 'SKILL_B_CHANGED_AFTER_ADMISSION', 'disable-model-invocation: true\n');
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('QUEUE_B_SELECTED')), 'Queued selections reach separate turns');
  const queueA = model.requests.find(request => JSON.stringify(request.messages).includes('QUEUE_A_SELECTED'));
  const queueB = model.requests.find(request => JSON.stringify(request.messages).includes('QUEUE_B_SELECTED'));
  const systemA = queueA.messages.findLast(message => message.role === 'system').content;
  const systemB = queueB.messages.findLast(message => message.role === 'system').content;
  assert.ok(systemA.includes('QUEUE_MODE_A') && !systemA.includes('QUEUE_MODE_B'), 'Queued A keeps its submitted mode');
  assert.ok(systemB.includes('QUEUE_MODE_B') && !systemB.includes('QUEUE_MODE_A'), 'Queued B keeps its submitted mode');
  const automaticSkillsAfter = (payload, marker) => {
    const selectedIndex = payload.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(marker));
    return payload.messages.slice(selectedIndex + 1).filter(message => typeof message.content === 'string' && message.content.startsWith('IDE automatic skill binding'));
  };
  const skillsA = automaticSkillsAfter(queueA, 'QUEUE_A_SELECTED');
  const skillsB = automaticSkillsAfter(queueB, 'QUEUE_B_SELECTED');
  assert.equal(skillsA.length, 1); assert.equal(skillsB.length, 1);
  assert.ok(skillsA[0].content.includes('SKILL_A_ORIGINAL') && !skillsA[0].content.includes('CHANGED_AFTER_ADMISSION'), 'Queued A freezes skill content at admission');
  assert.ok(skillsB[0].content.includes('SKILL_B_ORIGINAL') && !skillsB[0].content.includes('CHANGED_AFTER_ADMISSION'), 'Queued B freezes its own skill content independently');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'Queued selections idle');
  await call('/mode', { sessionId: id, mode: 'general' });
  const retainedCustom = { customPrompt: 'QUEUE_MODE_B', skillNames: ['integration-skill-b'] };
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: id })).customMode, retainedCustom, 'Leaving custom mode retains its exact session template');
  await call('/mode', { sessionId: null, mode: 'custom', customPrompt: 'FUTURE_SESSION_DEFAULT', skillNames: ['integration-skill-a'] });
  await call('/mode', { sessionId: null, mode: 'general' });
  const newSelection = await call('/context', { id: 'explicit-null-target', sessionId: null, mode: 'general', text: 'EXPLICIT_NULL_CREATES_NEW_SESSION' });
  assert.notEqual(newSelection.sessionId, id, 'An explicit null target creates a session even if the browser selected another session meanwhile');
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: newSelection.sessionId })).customMode,
    { customPrompt: 'FUTURE_SESSION_DEFAULT', skillNames: ['integration-skill-a'] }, 'A new session inherits the default custom template without activating it');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === newSelection.sessionId)?.running, 'Explicit null selection idle');
  await call('/context', selection); // Restore the original native navigation with its existing receipt.
  await call('/context', { id: 'manual-skill', sessionId: id, text: 'NATIVE_MANUAL_SKILL_SELECTED', prompt: '/integration-skill-a\nUse the named skill for this request.' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('NATIVE_MANUAL_SKILL_SELECTED')), 'Native explicit skill invocation reaches the model');
  const manualSkill = model.requests.find(request => JSON.stringify(request.messages).includes('NATIVE_MANUAL_SKILL_SELECTED'));
  assert.equal(automaticSkillsAfter(manualSkill, 'NATIVE_MANUAL_SKILL_SELECTED').length, 0, 'General mode does not inject an automatic skill');
  assert.ok(manualSkill.messages.some(message => typeof message.content === 'string' && message.content.includes('<skill_content name="integration-skill-a">') && message.content.includes('SKILL_A_CHANGED_AFTER_ADMISSION')), 'The original DSH slash-skill path remains functional');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'Manual skill turn idle');
  // Native navigation creates real blank sessions, including permission and
  // sandbox initialization events before the IDE's session/created listener.
  // Test that path directly instead of using the bridge's /sessions helper.
  const nativeTemplate = { customPrompt: '', skillNames: ['ide-code-tutor'] };
  await call('/mode', { sessionId: null, mode: 'custom', ...nativeTemplate });
  const nativeBlankId = await nativeCreate({ workspaceId: workspaceResult.value.workspace.workspaceId });
  await call('/health'); // Drain the asynchronous creation-hook persistence.
  const nativeCreatedModes = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8')).modes;
  assert.equal(nativeCreatedModes[nativeBlankId]?.mode, 'custom', 'Native creation inherits the active default before any IDE mode lookup');
  assert.deepEqual(nativeCreatedModes[nativeBlankId].customMode, nativeTemplate);
  const initializedEvents = await nativeEvents(nativeBlankId);
  assert.ok(initializedEvents.some(event => event.type === 'permission/preset'), 'A real native blank session contains initialized permission events');
  assert.ok(!initializedEvents.some(event => event.type === 'turn/start'));
  assert.equal((await call('/sessions')).items.find(item => item.sessionId === nativeBlankId).blank, true);
  const legacyBlankBrowserId = await nativeCreate({ workspaceId: workspaceResult.value.workspace.workspaceId });
  const legacyBlankConfigId = await nativeCreate({ workspaceId: workspaceResult.value.workspace.workspaceId });
  const foreignDir = await mkdtemp(join(tmpdir(), 'idea-dsh-foreign-project-'));
  const foreignBlankId = await nativeCreate({ cwd: foreignDir });
  await call('/mode', { sessionId: null, mode: 'custom', customPrompt: 'FUTURE_SESSION_DEFAULT', skillNames: ['integration-skill-a'] });
  await call('/mode', { sessionId: null, mode: 'general' });
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: nativeBlankId })).customMode, nativeTemplate, 'Changing defaults does not rewrite a native blank session that already inherited a binding');
  await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: foreignBlankId }, { status: 404 });
  assert.ok(!Object.hasOwn(JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8')).modes, foreignBlankId), 'Native blank sessions in another workspace do not inherit this IDE instance\'s mode');
  await call('/context', { id: 'restart-hold', sessionId: id, mode: 'general', text: 'RESTART_HOLD_SELECTED' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('RESTART_HOLD_SELECTED')), 'Restart hold turn starts');
  const userCanceledSelection = { id: 'user-canceled-selection', sessionId: id, mode: 'general', text: 'USER_CANCELED_MUST_NOT_RUN' };
  await call('/context', userCanceledSelection);
  const canceledItem = (await nativeQueue(id)).find(item => item.rpcId === 'ide-user-canceled-selection');
  assert.ok(canceledItem, 'The official control stream exposes the pending selection');
  const removed = await browserRequest('/api/session/updateQueue', {
    type: 'client-request', rpcId: 'native-remove-queued', method: 'session/updateQueue',
    payload: { args: { request: { sessionId: id, itemId: canceledItem.id, action: { kind: 'remove' } } } },
  });
  assert.equal(removed.result.ok, true, JSON.stringify(removed.result));
  const userCanceledRetry = await fetch(endpoint + '/context', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(userCanceledSelection) });
  assert.equal(userCanceledRetry.status, 409, 'Retrying an old receipt cannot undo the user\'s native queue removal');
  assert.equal((await userCanceledRetry.json()).code, 'selection-canceled');
  assert.ok(!model.requests.some(request => JSON.stringify(request.messages).includes('USER_CANCELED_MUST_NOT_RUN')));
  const restartPendingSelection = { id: 'restart-pending-skill', sessionId: id, mode: 'custom', customPrompt: 'QUEUE_MODE_B', skillNames: ['integration-skill-b'], text: 'RESTART_PENDING_SKILL_SELECTED' };
  await call('/context', restartPendingSelection);
  await writeSkill('integration-skill-b', 'SKILL_B_CHANGED_AFTER_RESTART', 'disable-model-invocation: true\n');
  await call('/mode', { sessionId: id, mode: 'general' });
  assert.ok(!model.requests.some(request => JSON.stringify(request.messages).includes('RESTART_PENDING_SKILL_SELECTED')), 'The skill-bound selection is still queued when stopping the process');
  const countBeforeRestart = model.requests.length;
  await stopRuntime();
  // Simulate persisted sessions produced by the old bridge: two never-used
  // native sessions and one real conversation have no IDE mode record.
  const legacyState = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8'));
  for (const legacyId of [legacyBlankBrowserId, legacyBlankConfigId, newSelection.sessionId]) delete legacyState.modes[legacyId];
  await writeFile(join(home, 'ide-bridge-state.json'), JSON.stringify(legacyState), { mode: 0o600 });
  startRuntime();
  await until(() => endpoint && webUrl, 'Restart with persisted modes and receipts');
  endpoint = JSON.parse(endpoint).endpoint;
  origin = new URL(webUrl).origin;
  const restartedExchange = await fetch(webUrl, { redirect: 'manual' });
  assert.equal(restartedExchange.status, 303);
  cookie = restartedExchange.headers.get('set-cookie').split(';', 1)[0];
  assert.deepEqual(await call('/context', selection), sent, 'Restart retry returns the persisted receipt');
  assert.equal(model.requests.length, countBeforeRestart, 'A successful prior selection is not sent again');
  const persisted = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8'));
  assert.equal(persisted.modes[id].mode, 'general');
  assert.equal(persisted.defaultMode.customPrompt, 'FUTURE_SESSION_DEFAULT');
  assert.deepEqual(persisted.receipts['integration-queue-a'].skillSnapshots.map(skill => skill.name), ['integration-skill-a']);
  assert.ok(persisted.receipts['integration-queue-a'].skillSnapshots[0].content.includes('SKILL_A_ORIGINAL'), 'Accepted skill bodies survive a process restart');
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: id })).customMode, retainedCustom, 'Custom template survives switching to general and restarting');
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: null })).customMode,
    { customPrompt: 'FUTURE_SESSION_DEFAULT', skillNames: ['integration-skill-a'] }, 'The default template remains distinct from the selected session');
  const migrationTemplate = { customPrompt: 'FUTURE_SESSION_DEFAULT', skillNames: ['integration-skill-a'] };
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: nativeBlankId })).customMode, nativeTemplate, 'An existing native blank binding survives a process restart');
  const browserBeforeMigration = await browserRequest('/ide-dsh/browser', { sessionId: id, navigationRevision: Number.MAX_SAFE_INTEGER });
  const migratedBrowser = await browserRequest('/ide-dsh/browser', { sessionId: legacyBlankBrowserId, navigationRevision: browserBeforeMigration.navigation.revision });
  assert.equal(migratedBrowser.sessionId, legacyBlankBrowserId);
  assert.equal(migratedBrowser.mode, 'general');
  assert.deepEqual(migratedBrowser.customMode, migrationTemplate, 'Opening an old unmarked blank session migrates its default template once');
  assert.deepEqual((await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: legacyBlankConfigId })).customMode, migrationTemplate, 'Reading mode config also migrates an old blank session without requiring navigation');
  await browserRequest('/ide-dsh/action', { action: 'mode-config', sessionId: foreignBlankId }, { status: 404 });
  await browserRequest('/ide-dsh/browser', { sessionId: foreignBlankId, navigationRevision: Number.MAX_SAFE_INTEGER }, { status: 404 });
  assert.equal((await call('/state')).sessionId, legacyBlankBrowserId, 'A rejected foreign-workspace selection leaves the current IDE session unchanged');
  const oldConversation = await browserRequest('/ide-dsh/browser', { sessionId: newSelection.sessionId, navigationRevision: Number.MAX_SAFE_INTEGER });
  assert.equal(oldConversation.mode, 'general');
  assert.deepEqual(oldConversation.customMode, { customPrompt: '', skillNames: [] }, 'Unmarked conversations with real turn history remain general and do not inherit later defaults');
  assert.ok((await nativeEvents(newSelection.sessionId)).some(event => event.type === 'turn/start'));
  const migratedState = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8'));
  for (const blankId of [legacyBlankBrowserId, legacyBlankConfigId]) assert.deepEqual(migratedState.modes[blankId].customMode, migrationTemplate, 'Blank migration is persisted instead of a changing fallback');
  assert.ok(!Object.hasOwn(migratedState.modes, newSelection.sessionId));
  assert.ok(!Object.hasOwn(migratedState.modes, foreignBlankId));
  await call('/mode', { sessionId: null, mode: 'tutor' });
  await browserRequest('/ide-dsh/browser', { sessionId: legacyBlankBrowserId, navigationRevision: Number.MAX_SAFE_INTEGER });
  assert.equal((await call('/state')).mode, 'general', 'Changing the default after migration cannot activate skills in an existing blank session');
  await call('/mode', { sessionId: null, mode: 'general' });
  await call('/context', selection);
  const canceledRetry = await fetch(endpoint + '/context', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(restartPendingSelection) });
  assert.equal(canceledRetry.status, 409, 'A canceled pending receipt cannot falsely report successful queue admission after restart');
  const canceledValue = await canceledRetry.json();
  assert.equal(canceledValue.code, 'selection-canceled');
  assert.ok(canceledValue.error.includes('重新选择代码并发送'));
  await nativePrompt('native-restart-resume', id, 'AFTER_RESTART_RESUME');
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('AFTER_RESTART_RESUME')), 'Native conversation continues after restart');
  assert.ok(!model.requests.some(request => JSON.stringify(request.messages).includes('RESTART_PENDING_SKILL_SELECTED')), 'Restart-canceled work is never automatically resurrected');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'Native input after restart idle');
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: id, mode: 'custom' });
  await call('/context', { id: 'post-restart-skill', sessionId: id, text: 'POST_RESTART_SKILL_SELECTED' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('POST_RESTART_SKILL_SELECTED')), 'Restored custom binding reaches the next turn');
  const restartedSkill = model.requests.find(request => JSON.stringify(request.messages).includes('POST_RESTART_SKILL_SELECTED'));
  const restoredBindings = automaticSkillsAfter(restartedSkill, 'POST_RESTART_SKILL_SELECTED');
  assert.equal(restoredBindings.length, 1);
  assert.ok(restoredBindings[0].content.includes('SKILL_B_CHANGED_AFTER_RESTART') && !restoredBindings[0].content.includes('SKILL_A_'), 'A new turn loads the restored session binding rather than another session or an old queued snapshot');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'Restored custom skill turn idle');
  await call('/mode', { sessionId: id, mode: 'custom', customPrompt: '', skillNames: ['integration-skill-a'] });
  await rm(skillFile('integration-skill-a'));
  const missing = await fetch(endpoint + '/context', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'missing-skill-context', sessionId: id, text: 'MUST_NOT_RUN_WITH_MISSING_SKILL' }) });
  assert.equal(missing.status, 409);
  assert.ok((await missing.json()).error.includes('integration-skill-a'), 'A missing bound skill reports its exact name instead of silently downgrading');
  assert.ok(!model.requests.some(request => JSON.stringify(request.messages).includes('MUST_NOT_RUN_WITH_MISSING_SKILL')));
  await nativePrompt('native-missing-skill', id, 'NATIVE_INPUT_WITH_MISSING_SKILL');
  await until(async () => (await call('/state')).status.message.includes('integration-skill-a'), 'Missing native-mode skill becomes a visible turn error');
  assert.equal((await call('/state')).status.kind, 'error');
  assert.ok(!model.requests.some(request => JSON.stringify(request.messages).includes('NATIVE_INPUT_WITH_MISSING_SKILL')), 'The native conversation cannot silently execute with a missing bound skill');
  await call('/mode', { sessionId: id, mode: 'general' });
  assert.notEqual((await call('/state')).status.kind, 'error', 'Fixing the mode clears its prior skill error immediately');
  const result = { home, projectDir, webUrl, endpoint, token, modelBaseURL: model.baseURL,
    tools: request.tools.map(tool => tool.function?.name), requests: model.requests.length };
  await writeFile(join(home, 'integration-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, home, projectDir, endpoint, modelBaseURL: model.baseURL,
    toolCount: request.tools.length, requests: model.requests.length }));
  keep = process.env.DSH_TEST_KEEP === '1';
  if (keep) {
    console.log(`Fixture stays available; private connection details: ${join(home, 'integration-result.json')}`);
    await new Promise(resolveStop => { process.once('SIGTERM', resolveStop); process.once('SIGINT', resolveStop); });
  }
} catch (error) {
  console.error(errors.slice(-12000));
  throw error;
} finally {
  await stopRuntime();
  model.server.closeAllConnections();
  await new Promise(done => model.server.close(done));
}
