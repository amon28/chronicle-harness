// Claude as a provider (decision 164): the official Anthropic SDK pointed at the mock's Anthropic-format endpoint.
import { test, expect, send, MOCK } from './helpers.js';

const claudeReqs = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r._anthropic);

test.describe('adding the provider', () => {
  test('add Anthropic (Claude) with a key, Test lists the models and replies, pick Claude, a reply streams', async ({ app, request }) => {
    await app.click('#menu-btn');
    await app.click('#open-settings');
    await app.click('.set-item[data-page="account"]');
    await app.click('#open-providers');
    await expect(app.locator('#prov-list')).toContainText('Anthropic (Claude)'); // the empty list names all three buttons below it
    await app.click('#prov-add-anthropic');
    await expect(app.locator('#pv-name')).toHaveValue('Anthropic (Claude)');
    await expect(app.locator('#pv-url-hint')).toBeHidden(); // Anthropic's base URL does not end in /v1
    await expect(app.locator('#pv-anthropic-note')).toBeVisible();
    await expect(app.locator('#pv-auth')).toBeHidden(); // the SDK sends the key; no OpenAI-only options
    await app.fill('#pv-url', MOCK + '/anthropic');
    await app.click('#pv-test');
    await expect(app.locator('#pv-status')).toContainText('Enter your Anthropic API key');
    await app.fill('#pv-key', 'sk-ant-wrong');
    await app.click('#pv-test');
    await expect(app.locator('#pv-status')).toContainText('Anthropic did not accept the API key'); // a 401 → the typed error
    await app.fill('#pv-key', 'sk-ant-good');
    await app.click('#pv-test');
    await expect(app.locator('#pv-status')).toContainText('Model list: ✓ 2 – claude-opus-5-5, claude-sonnet-5-5');
    await expect(app.locator('#pv-status')).toContainText('replied: “Hello from claude-opus-5-5!');
    await app.click('#pv-save');
    await expect(app.locator('#prov-list')).not.toContainText('None yet'); // saved (the empty list's words name it too)
    await expect(app.locator('#prov-list')).toContainText('Anthropic (Claude)');
    await app.evaluate(() => document.querySelectorAll('.sheet.open').forEach((x) => x.querySelector('[data-close]')?.click()));

    await app.click('#model-btn');
    await app.locator('#model-list .model-item', { hasText: 'Claude Opus 5.5' }).first().click();
    await expect(app.locator('#model-name')).toHaveText('Claude Opus 5.5');
    await expect(app.locator('#effort-btn')).toBeVisible(); // the model's effort levels from models.list()
    await send(app, 'Hi Claude');
    const last = app.locator('.msg.assistant').last();
    await expect(last).toContainText('Hello from claude-opus-5-5! You said: Hi Claude');
    await expect(last).toContainText('A friendly greeting fits.'); // the summarized thinking
    const req = (await claudeReqs(request)).at(-1);
    expect(req).toMatchObject({ model: 'claude-opus-5-5', stream: true, thinking: { type: 'adaptive', display: 'summarized' }, cache_control: { type: 'ephemeral' }, max_tokens: 64000 });
    expect(req.system).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral' } }]); // a cache point at the end of the system prompt
    expect(req).not.toHaveProperty('temperature');
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hi Claude' }] });
  });
});

test.describe('agent mode', () => {
  test.use({
    appSettings: {
      model: 'pvT:claude-opus-5-5',
      providers: [{ id: 'pvT', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: MOCK + '/anthropic', apiKey: 'sk-ant-good', via: 'native', models: 'claude-opus-5-5', context: 1000000, tools: true, vision: true, enabled: true }],
      prefs: { tools: true },
    },
  });

  test('a tool call round-trip: tool_use runs, its tool_result goes back in one user message with the thinking block kept', async ({ app, request }) => {
    await expect(app.locator('#model-name')).toHaveText('Claude Opus 5.5');
    await send(app, 'ANTHTOOL write a file');
    await expect(app.locator('.msg.assistant').last()).toContainText('Claude saw the result:');
    await expect(app.locator('.msg.assistant').last().locator('.act-meta')).toContainText('% cached'); // cache_read_input_tokens
    const reqs = await claudeReqs(request);
    expect(reqs.length).toBe(2);
    expect(reqs[0].tools.some((t) => t.name === 'write_file' && t.input_schema?.type === 'object')).toBe(true);
    expect(reqs[0].tool_choice).toEqual({ type: 'auto' });
    expect(reqs[0]._beta).toBe('server-side-fallback-2026-07-01'); // the refusal fallback, on every Opus 5.5 request
    const asst = reqs[1].messages.at(-2);
    expect(asst.role).toBe('assistant');
    // preserved thinking: the block comes back unchanged and first, then the text, then the call
    expect(asst.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(asst.content[0]).toEqual({ type: 'thinking', thinking: 'I should write the file.', signature: 'sig-0' });
    expect(asst.content[2]).toMatchObject({ id: 'toolu_mock1', name: 'write_file', input: { path: 'claude.txt', content: 'written by Claude' } });
    const user = reqs[1].messages.at(-1);
    expect(user.role).toBe('user');
    expect(user.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_mock1' });
    // replaying thinking: the API is asked to drop a block it can no longer verify instead of failing
    expect(reqs[1]._beta).toBe('thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01');
    expect(reqs[1].thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });

    // the next message: the finished reply's thinking block goes back too
    await send(app, 'thanks');
    const third = (await claudeReqs(request)).at(-1);
    const prev = third.messages.filter((m) => m.role === 'assistant').at(-1);
    expect(prev.content[0]).toEqual({ type: 'thinking', thinking: 'The file is written.', signature: 'sig-0' });
  });
});
