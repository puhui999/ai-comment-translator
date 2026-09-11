/** Focused failure-injection checks for IDE admission retries; no model or IDE required. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { apply } from '../idea-plugin/src/main/resources/dsh/idea-bridge.mjs';

const home = await mkdtemp(join(tmpdir(), 'dsh-reservation-home-'));
const projectDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-reservation-project-')));
const token = randomBytes(32).toString('hex');
Object.assign(process.env, { DSH_HOME: home, DSH_IDE_PROJECT_DIR: projectDir, DSH_IDE_BRIDGE_TOKEN: token });
const originalArgv = process.argv[1];
process.argv[1] = join(process.env.DSH_TEST_RUNTIME ?? '/tmp/dsh-agent-dev-runtime', 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const sessions = new Map(); const skills = new Map(); const disposers = [];
const admitted = [];
let endpoint; let failPrompt = true; let unavailableInLiveScope = false;
for (const name of ['fixture-skill-a', 'fixture-skill-b']) skills.set(name, {
  name, description: name, source: 'fixture', provider: 'fixture', content: `${name} instructions`,
  invocation: { userInvocable: true, modelInvocable: true },
});
const ctx = {
  skills: {
    register: skill => { skills.set(skill.name, { ...skill, invocation: { userInvocable: true, modelInvocable: true } }); return () => skills.delete(skill.name); },
    get: async (name, options) => unavailableInLiveScope && options.scope ? undefined : skills.get(name),
    snapshot: async () => ({ complete: true, skills: [...skills.values()] }),
  },
  agents: { get: id => sessions.get(id)?.agent },
  sessionQuery: { readSession: async () => ({ events: [] }) },
  workspaceController: { create: async () => ({ workspace: { workspaceId: 'fixture-workspace' } }) },
  sessionController: {
    list: async () => ({ items: [...sessions].map(([sessionId]) => ({ sessionId, cwd: projectDir })) }),
    create: async () => {
      const sessionId = `fixture-session-${sessions.size + 1}`;
      sessions.set(sessionId, { agent: { session: { id: sessionId, header: { cwd: projectDir } } } });
      return { sessionId };
    },
    prompt: async request => { admitted.push(request); if (failPrompt) throw new Error('Fixture admission failure'); return { accepted: true }; },
  },
  systemPrompt: { section: () => () => {} },
  webServer: { register: () => () => {} }, connection: { requestRejection: () => undefined },
  get: () => undefined, on: () => () => {},
  effect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); },
};
const log = console.log;
console.log = message => { if (String(message).startsWith('DSH_IDE_BRIDGE_READY ')) endpoint = JSON.parse(message.slice('DSH_IDE_BRIDGE_READY '.length)).endpoint; else log(message); };
try { await apply(ctx); }
finally { console.log = log; process.argv[1] = originalArgv; }
const call = async (path, value, expected = 200) => {
  const response = await fetch(endpoint + path, {
    method: value ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
};
try {
  const original = { id: 'failed-admission', sessionId: null, mode: 'custom', customPrompt: 'Mode A', skillNames: ['fixture-skill-a'], text: 'Selected source' };
  await call('/context', original, 500);
  const state = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8'));
  const target = state.receipts[original.id].sessionId;
  await call('/mode', { sessionId: target, mode: 'custom', customPrompt: 'Mode B', skillNames: ['fixture-skill-b'] });
  failPrompt = false;
  const retried = await call('/context', original);
  assert.equal(retried.sessionId, target);
  assert.equal(sessions.size, 1, 'A retry retains the original null-target reservation');
  assert.equal((await call('/state')).customPrompt, 'Mode B', 'Retrying an older selection does not reset the newer session mode');
  assert.deepEqual((await call('/state')).customMode, { customPrompt: 'Mode B', skillNames: ['fixture-skill-b'] });
  const afterRetry = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8'));
  assert.deepEqual(afterRetry.receipts[original.id].mode.skillNames, ['fixture-skill-a'], 'The retried selection itself retains its original binding');
  assert.ok(afterRetry.receipts[original.id].skillSnapshots[0].content.includes('fixture-skill-a'));

  unavailableInLiveScope = true;
  const scopedFailure = { id: 'failed-actual-scope', sessionId: null, mode: 'custom', customPrompt: 'Scoped A', skillNames: ['fixture-skill-a'], text: 'Another selection' };
  await call('/context', scopedFailure, 409);
  const reserved = JSON.parse(await readFile(join(home, 'ide-bridge-state.json'), 'utf8')).receipts[scopedFailure.id];
  assert.ok(reserved.sessionId, 'Actual-scope validation failure still retains the created session target');
  assert.equal(sessions.size, 2);
  unavailableInLiveScope = false;
  assert.equal((await call('/context', scopedFailure)).sessionId, reserved.sessionId);
  assert.equal(sessions.size, 2, 'Retrying a scope failure does not create a second orphan session');
  console.log(JSON.stringify({ ok: true, checks: ['retry-mode-isolation', 'null-target-reservation', 'actual-scope-failure-reservation'] }));
} finally {
  for (const dispose of disposers.reverse()) await dispose();
}
