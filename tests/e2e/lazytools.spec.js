import { test, expect, lastRequest, offeredTools } from './helpers.js';

// Seldom-used built-in tools wait in load_tools (decision 175): named, not defined, until the model uses one.
test.use({ appSettings: { prefs: { tools: true } } });

const full = (req) => (req.tools || []).filter((t) => t.function.name !== 'load_tools').map((t) => t.function.name);
const finished = (app) => app.waitForFunction(() => !document.body.classList.contains('streaming'), null, { timeout: 30000 });

test('doctor is named in load_tools, not sent in full; called directly it works and stays loaded', async ({ app, request }) => {
  await app.fill('#input', 'hello');
  await app.click('#send-btn');
  await finished(app);
  let req = await lastRequest(request);
  expect(full(req)).toContain('read_file');
  expect(full(req)).not.toContain('doctor');
  expect(full(req)).not.toContain('schedule_task');
  expect(offeredTools(req)).toContain('doctor'); // still offered, by name
  // the model calls it without loading it first: it runs, and the next request carries its full definition
  await app.fill('#input', 'DOCALLS [["doctor",{"surfaces":["browser"],"network":false}]]');
  await app.click('#send-btn');
  await finished(app);
  await app.fill('#input', 'thanks');
  await app.click('#send-btn');
  await finished(app);
  req = await lastRequest(request);
  expect(full(req)).toContain('doctor');
  expect(full(req)).not.toContain('schedule_task');
});

test.describe('switched off', () => {
  test.use({ appSettings: { prefs: { tools: true, lazyTools: false } } });
  test('every tool is sent in full', async ({ app, request }) => {
    await app.fill('#input', 'hello');
    await app.click('#send-btn');
    await finished(app);
    const req = await lastRequest(request);
    expect(full(req)).toContain('doctor');
    expect(full(req)).toContain('schedule_task');
  });
});

test('loading a tool keeps the start of the request: it goes at the end, load_tools names the same tools, its guidance comes in the result', async ({ app, request }) => {
  await app.fill('#input', 'hello');
  await app.click('#send-btn');
  await finished(app);
  const before = await lastRequest(request);
  const sysOf = (r) => String(r.messages[0].content);
  const listOf = (r) => r.tools.find((t) => t.function.name === 'load_tools').function.description;
  expect(sysOf(before)).not.toContain('call schedule_task'); // its guidance waits with the tool
  await app.fill('#input', 'DOCALLS [["load_tools",{"names":["schedule_task"]}]]');
  await app.click('#send-btn');
  await finished(app);
  await app.fill('#input', 'thanks');
  await app.click('#send-btn');
  await finished(app);
  const after = await lastRequest(request);
  const names = full(after);
  expect(names.at(-1)).toBe('schedule_task'); // added at the end, not in its usual place
  expect(names.slice(0, -1)).toEqual(full(before)); // everything before it as it was
  expect(listOf(after)).toBe(listOf(before)); // the held-back list does not shrink
  expect(sysOf(after)).toBe(sysOf(before)); // the system prompt did not change either
  const loaded = after.messages.find((m) => m.role === 'tool' && String(m.content).includes('Loaded schedule_task'));
  expect(String(loaded.content)).toContain('call schedule_task'); // the guidance came with the load
});

test.describe('the lighter tool set', () => {
  test.use({ appSettings: { prefs: { tools: true, leanTools: 'on' } } });
  test('scripts and helpers wait in load_tools, their guidance too; a load brings both', async ({ app, request }) => {
    await app.fill('#input', 'hello');
    await app.click('#send-btn');
    await finished(app);
    const req = await lastRequest(request);
    expect(full(req)).not.toContain('run_script');
    expect(full(req)).not.toContain('delegate');
    expect(full(req)).toContain('read_file');
    expect(offeredTools(req)).toContain('run_script');
    expect(String(req.messages[0].content)).not.toContain('Code mode:');
    await app.fill('#input', 'DOCALLS [["load_tools",{"names":["run_script"]}]]');
    await app.click('#send-btn');
    await finished(app);
    const after = await lastRequest(request);
    expect(full(after).at(-1)).toBe('run_script');
    expect(String(after.messages.find((m) => m.role === 'tool' && String(m.content).includes('Loaded run_script')).content)).toContain('Code mode:');
  });
});
