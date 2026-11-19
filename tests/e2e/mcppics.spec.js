import { test, expect, lastRequest, MOCK } from './helpers.js';

// MCP results with pictures reach a model that sees (decision 201); a trusted server's read-only tool is a read
test.use({ appSettings: { model: 'kimi-k3', prefs: { tools: true, agentMode: 'auto' }, mcpServers: [{ id: 'mcp_p', name: 'pics', url: `${MOCK}/mcp-pics`, enabled: true, trusted: true }] } });

test('a picture in an MCP result is shown to the model after the result', async ({ app, request }) => {
  await app.fill('#input', 'DOCALLS [["mcp_pics_snap",{}]]');
  await app.click('#send-btn');
  await app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 20000 });
  const req = await lastRequest(request);
  const result = req.messages.find((m) => m.role === 'tool');
  expect(String(result.content)).toContain('[picture 1 – shown to you after this result]');
  const pics = req.messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  expect(pics.length).toBe(1);
  expect(JSON.stringify(pics[0].content)).toContain('data:image/png;base64,');
});
