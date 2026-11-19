import { test, expect, MOCK } from './helpers.js';

const requests = async (request) => (await (await request.get(MOCK + '/__requests')).json()).filter((r) => r.messages);
const idle = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

test.describe('tools', () => {
  test.use({ appSettings: { model: 'hy3', prefs: { tools: true } } });

  test('retry with another model: that model gets its reasoning back between tool steps', async ({ app, request }) => {
    await app.fill('#input', 'DOCALLS [["list_files",{}]]');
    await app.click('#send-btn');
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS:', { timeout: 15000 });
    await idle(app);
    await app.locator('.msg.assistant').last().locator('.act-more').click();
    await app.click('#mm-retry-model');
    await app.selectOption('#mm-model', 'deepseek-v4-pro');
    await app.click('#mm-model-go');
    await expect(app.locator('.msg.assistant').last()).toContainText('RESULTS:', { timeout: 15000 });
    await idle(app);
    const reqs = (await requests(request)).filter((r) => r.model === 'deepseek-v4-pro' && r.messages.some((m) => m.role === 'tool'));
    expect(reqs).toHaveLength(1);
    const withCalls = reqs[0].messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(withCalls.reasoning_content).toBe('Which calls? These.'); // DeepSeek refuses the step without it
    // and the first model (no reasoning field) was not sent one
    const first = (await requests(request)).find((r) => r.model === 'hy3' && r.messages.some((m) => m.role === 'tool'));
    expect(first.messages.find((m) => m.role === 'assistant' && m.tool_calls).reasoning_content).toBeUndefined();
  });
});

test.describe('context limit of the model asked for', () => {
  test.use({ appSettings: { model: 'hy3', learnedLimits: { 'deepseek-v4-pro': 3000 } } });

  test('retry with another model: the request fits that model, not the chat\'s', async ({ app, request }) => {
    for (const word of ['FIRSTLONG', 'SECONDLONG']) {
      await app.fill('#input', word + ' ' + 'lorem ipsum '.repeat(700));
      await app.click('#send-btn');
      await idle(app);
    }
    await app.locator('.msg.assistant').last().locator('.act-more').click();
    await app.click('#mm-retry-model');
    await app.selectOption('#mm-model', 'deepseek-v4-pro');
    await app.click('#mm-model-go');
    await idle(app);
    const reqs = (await requests(request)).filter((r) => r.model === 'deepseek-v4-pro');
    expect(reqs.length).toBeGreaterThan(0);
    const text = JSON.stringify(reqs.at(-1).messages);
    expect(text).toContain('SECONDLONG');
    expect(text).not.toContain('FIRSTLONG'); // slid out: the two together are over that model's 3000 tokens
    // the chat's own model still gets both
    const first = (await requests(request)).filter((r) => r.model === 'hy3').at(-1);
    expect(JSON.stringify(first.messages)).toContain('FIRSTLONG');
  });
});
