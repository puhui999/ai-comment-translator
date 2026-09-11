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
  let plugin; let subscriber; let release; let dispose; let selected = 'session-a';
  const posted = [];
  runInNewContext(await readFile(join(resource, '../idea-client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: entry => { plugin = entry.factory(); } } },
    crypto: { randomUUID: () => 'client-test' }, AbortController, console, queueMicrotask,
    setInterval: () => 1, clearInterval: () => {},
    fetch: async (_url, options) => {
      posted.push(JSON.parse(options.body));
      if (posted.length === 1) await new Promise(done => { release = done; });
      return { ok: true, json: async () => ({}) };
    },
  });
  plugin.apply({
    sessions: { list: { getSnapshot: () => ({ current: selected }), subscribe: listener => { subscriber = listener; return () => {}; } } },
    uiWorkspace: { openSession: () => {} }, effect: effect => { dispose = effect(); },
  });
  selected = 'session-b'; subscriber(); release();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(posted.map(item => item.sessionId), ['session-a', 'session-b']);
  dispose();
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
  await call('/mode', { mode: 'custom', customPrompt: 'FUTURE_SESSION_DEFAULT', sessionId: null });
  assert.equal((await call('/state')).mode, 'tutor', 'Default changes cannot rewrite the selected session');
  const selection = { id: 'integration-selection', text: 'const answer = 42;', mode: 'tutor', prompt: 'IDE_TOOL_TEST: read the original file and explain the selection.', filePath: join(projectDir, 'learning.ts'), unsaved: true,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 19, startOffset: 0, endOffset: 18 }, documentVersion: 3 };
  const sent = await call('/context', selection);
  assert.equal(sent.accepted, true);
  assert.deepEqual(await call('/context', selection), sent, 'retry is idempotent');
  await until(() => model.requests.some(request => JSON.stringify(request.messages).includes('const answer = 42;')), 'Model received IDE selection');
  const request = model.requests.find(request => JSON.stringify(request.messages).includes('const answer = 42;'));
  const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('programming learning assistant'), 'Additive tutor prompt reached the real adapter');
  assert.ok(request.tools.length > 5, 'Full standard agent tool roster remains present');
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
