/** Local OpenAI-compatible streaming fixture. No external model or key required. */
import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';

export async function startFakeModel({ port = 0, recordPath, delayMs = 20, toolTestPath } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/requests') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(requests)); return;
    }
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      response.writeHead(404); response.end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    if (recordPath) await appendFile(recordPath, JSON.stringify(payload) + '\n');
    const lastUser = payload.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('IDE_TOOL_TEST'));
    const tool = payload.tools?.find(tool => tool.function.name === 'read' && tool.function.parameters.properties.file_path);
    const toolRequested = toolTestPath && tool && lastUser >= 0;
    const completedTool = payload.messages.slice(lastUser + 1).find(message => message.role === 'tool');
    const text = completedTool ? `真实 DSH read 工具已返回文件内容：${completedTool.content}` : '这是本地测试模型的回复。已收到 IDE 选中的代码和当前模式指令；完整 DSH 对话、工具与会话管理由官方运行时提供。';
    if (!payload.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture-response', object: 'chat.completion', model: payload.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: 'fixture-response', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    send({ role: 'assistant', content: '' });
    if (toolRequested && !completedTool) {
      // Give the integration caller time to change mode during this turn.
      await new Promise(done => setTimeout(done, 800));
      send({ tool_calls: [{ index: 0, id: 'fixture-read-call', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ file_path: toolTestPath }) } }] });
      send({}, 'tool_calls');
      response.end('data: [DONE]\n\n');
      return;
    }
    for (const part of text.match(/.{1,8}/gu)) {
      if (response.destroyed) return;
      await new Promise(done => setTimeout(done, delayMs));
      send({ content: part });
    }
    send({}, 'stop', { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  return { server, requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fixture = await startFakeModel({ port: Number(process.env.DSH_FAKE_PORT ?? 0), recordPath: process.env.DSH_FAKE_RECORD });
  console.log(JSON.stringify({ baseURL: fixture.baseURL, apiKey: 'local-fixture-key' }));
  process.on('SIGTERM', () => fixture.server.close());
}
