/** Integration against the published, unchanged DSH Web runtime and a local model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import { startFakeModel } from './dsh-fake-model.mjs';

const home = await mkdtemp(join(tmpdir(), 'idea-dsh-integration-'));
const projectDir = await mkdtemp(join(tmpdir(), 'idea-dsh-project-'));
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
await writeFile(patch, `- insert:\n    - id: ide-bridge\n      name: ${JSON.stringify(resource)}\n`);
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
  const cookie = exchange.headers.get('set-cookie').split(';', 1)[0];
  const origin = new URL(webUrl).origin;
  const html = await (await fetch(origin, { headers: { cookie } })).text();
  assert.ok(html.includes('@translate/idea-dsh-bridge'), 'IDE client joins the official full boot graph');
  const created = await call('/sessions', { mode: 'tutor' });
  const id = created.sessionId;
  assert.equal((await call('/sessions')).items.some(item => item.sessionId === id), true);
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
  await browserRequest('/ide-dsh/action', { action: 'settings' }, { includeCookie: false, status: 401 });
  await browserRequest('/ide-dsh/action', { action: 'settings' }, { requestOrigin: 'https://attacker.invalid', status: 403 });
  await browserRequest('/ide-dsh/action', { action: 'evaluate', code: 'alert(1)' }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', mode: 'general' }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: '', mode: 'general' }, { status: 400 });
  await browserRequest('/ide-dsh/action', { action: 'mode', sessionId: 'missing-session', mode: 'general' }, { status: 404 });
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
  const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('programming learning assistant'), 'Additive tutor prompt reached the real adapter');
  assert.equal(request.tools.length, 27, 'The pinned full Web profile keeps all 27 standard tools');
  await call('/mode', { mode: 'custom', customPrompt: 'CUSTOM_IDE_TEST_MODE' });
  await until(() => model.requests.some(request => request.messages.some(message => message.role === 'tool' && String(message.content).includes('IDE_READ_PROOF'))), 'Real DSH read tool result');
  const continued = model.requests.find(request => request.messages.some(message => message.role === 'tool' && String(message.content).includes('IDE_READ_PROOF')));
  const continuedSystem = continued.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(continuedSystem.includes('programming learning assistant'));
  assert.ok(!continuedSystem.includes('CUSTOM_IDE_TEST_MODE'), 'A mode change cannot alter later steps of an active turn');
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
  await call('/context', { id: 'integration-queue-a', text: 'QUEUE_A_SELECTED', mode: 'custom', customPrompt: 'QUEUE_MODE_A' });
  await call('/context', { id: 'integration-queue-b', text: 'QUEUE_B_SELECTED', mode: 'custom', customPrompt: 'QUEUE_MODE_B' });
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('QUEUE_B_SELECTED')), 'Queued selections reach separate turns');
  const queueA = model.requests.find(request => JSON.stringify(request.messages).includes('QUEUE_A_SELECTED'));
  const queueB = model.requests.find(request => JSON.stringify(request.messages).includes('QUEUE_B_SELECTED'));
  const systemA = queueA.messages.findLast(message => message.role === 'system').content;
  const systemB = queueB.messages.findLast(message => message.role === 'system').content;
  assert.ok(systemA.includes('QUEUE_MODE_A') && !systemA.includes('QUEUE_MODE_B'), 'Queued A keeps its submitted mode');
  assert.ok(systemB.includes('QUEUE_MODE_B') && !systemB.includes('QUEUE_MODE_A'), 'Queued B keeps its submitted mode');
  await until(async () => !(await call('/sessions')).items.find(item => item.sessionId === id)?.running, 'Queued selections idle');
  await call('/mode', { sessionId: id, mode: 'general' });
  const countBeforeRestart = model.requests.length;
  await stopRuntime();
  startRuntime();
  await until(() => endpoint && webUrl, 'Restart with persisted modes and receipts');
  endpoint = JSON.parse(endpoint).endpoint;
  assert.deepEqual(await call('/context', selection), sent, 'Restart retry returns the persisted receipt');
  assert.equal(model.requests.length, countBeforeRestart, 'A successful prior selection is not sent again');
  const persisted = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8'));
  assert.equal(persisted.modes[id].mode, 'general');
  assert.equal(persisted.defaultMode.customPrompt, 'FUTURE_SESSION_DEFAULT');
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
