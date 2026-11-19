import { describe, it, expect } from 'vitest';
import { AcpClient, readUpdate } from '../../src/acp.js';
import { ccModelEntries, ccModelFor, ccModelId, ccValueOf, effortStep, isCcModelId, mapEffort, mergeModelCache, modelStep, parseResetText, parseUsageMarkdown, readConfig, routeToClaudeCode, usageSummary, withEarlierTurns } from '../../src/ccmodels.js';

// Claude Code as models in the picker (decision 165). Fixtures have the shapes @agentclientprotocol/claude-agent-acp
// 0.107.0 builds (session-config-options.js buildConfigOptions, session-model.js buildModelConfigOption,
// session-effort.js buildEffortConfigOption, usage-markdown.js formatUsageResponse – the markdown below is that
// function's real output for the given numbers, made with TZ=UTC / TZ=Europe/Berlin / TZ=America/Los_Angeles).
const mode = { id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] };
const model = (current = 'default') => ({ id: 'model', name: 'Model', description: 'AI model to use', category: 'model', type: 'select', currentValue: current, options: [{ value: 'default', name: 'Default (recommended)', description: 'Opus 4.8 · Most capable' }, { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.6 · Everyday tasks' }, { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest' }] });
const effort = (current = 'default', levels = ['low', 'medium', 'high', 'xhigh', 'max']) => ({ id: 'effort', name: 'Effort', description: 'Available effort levels for this model', category: 'thought_level', type: 'select', currentValue: current, options: [{ value: 'default', name: 'Default' }, ...levels.map((l) => ({ value: l, name: l[0].toUpperCase() + l.slice(1) }))] });
const opusConfig = [mode, model('default'), effort()];
const haikuConfig = [mode, model('haiku')]; // Haiku has no effort option at all

const USAGE_UTC =
  '## Usage\n\n> Claude max subscription usage\n\n### Limits\n\n**5-hour limit** — **32%** · Resets Nov 14, 3:00 PM UTC\n\n`██████░░░░░░░░░░░░░░`\n\n**Weekly · all models** — **61.5%** · Resets Nov 18, 9:00 AM UTC\n\n`████████████░░░░░░░░`\n\n**Weekly · Opus** — **12%** · Resets Nov 18, 9:00 AM UTC\n\n`██░░░░░░░░░░░░░░░░░░`\n\n**Weekly · Sonnet** — **0%**\n\n`░░░░░░░░░░░░░░░░░░░░`\n\n---\n\n### This session\n\n| Cost | API time | Active |\n|:--|:--|:--|\n| $0.00 | 0s | 1s |\n\n| Breakdown | Tokens |\n|:--|--:|\n| Input | 0 |\n| Output | 0 |\n| Cache read | 0 |\n| Cache write | 0 |';
const USAGE_SCOPED =
  '## Usage\n\n> Claude max subscription usage\n\n### Limits\n\n**5-hour limit** — **32%** · Resets Nov 14, 4:00 PM GMT+1\n\n`██████░░░░░░░░░░░░░░`\n\n**Weekly · all models** — **61.5%** · Resets Nov 18, 10:00 AM GMT+1\n\n`████████████░░░░░░░░`\n\n**Weekly · Opus\\_4 \\[1m\\]** — **40%** · Resets Nov 18, 10:00 AM GMT+1\n\n`████████░░░░░░░░░░░░`\n\n---\n\n### This session\n\n| Cost | API time | Active |\n|:--|:--|:--|\n| $0.00 | 0s | 1s |';
const NOW = Date.UTC(2026, 10, 14, 12, 0);

describe('Claude Code models from configOptions', () => {
  it('reads the model select and the effort select of the current model', () => {
    const c = readConfig(opusConfig);
    expect(c.models.map((m) => m.value)).toEqual(['default', 'sonnet', 'haiku']);
    expect(c.models[1]).toEqual({ value: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.6 · Everyday tasks' });
    expect(c.model).toBe('default');
    expect(c.effort).toEqual({ current: 'default', levels: ['low', 'medium', 'high', 'xhigh', 'max'], hasDefault: true });
    expect(readConfig(haikuConfig).effort).toBeNull();
    expect(readConfig(undefined)).toEqual({ models: [], model: null, effort: null });
  });
  it('reads grouped select options too', () => {
    const grouped = [{ ...model('sonnet'), options: [{ group: 'g', name: 'Main', options: model().options.slice(0, 2) }, model().options[2]] }];
    expect(readConfig(grouped).models.map((m) => m.value)).toEqual(['default', 'sonnet', 'haiku']);
  });
  it('keeps the list and each model’s effort levels between sessions; the picker shows them as cc: models', () => {
    let cache = mergeModelCache(null, opusConfig);
    cache = mergeModelCache(cache, haikuConfig);
    expect(cache.effort).toEqual({ default: ['low', 'medium', 'high', 'xhigh', 'max'], haiku: [] });
    const list = ccModelEntries(cache);
    expect(list.map((m) => m.id)).toEqual(['cc:default', 'cc:sonnet', 'cc:haiku']);
    expect(list[0].capabilities.reasoning).toEqual({ supported: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(list[2].capabilities.reasoning.supported).toBe(false);
    expect(list.every((m) => m.source === 'claudecode')).toBe(true);
  });
  it('shows one "default model" entry before any session told it the list', () => {
    const list = ccModelEntries(null);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'cc:default', name: 'Claude Code – default model', placeholder: true });
  });
  it('model ids', () => {
    expect(ccModelId('opus')).toBe('cc:opus');
    expect(isCcModelId('cc:opus')).toBe(true);
    expect(isCcModelId('glm-5.3')).toBe(false);
    expect(ccValueOf('cc:sonnet[1m]')).toBe('sonnet[1m]');
  });
});

describe('effort', () => {
  const e = readConfig(opusConfig).effort;
  it('maps the 🧠 chip to the adapter’s levels', () => {
    expect(mapEffort('high', e)).toBe('high');
    expect(mapEffort(undefined, e)).toBe('default');
    expect(mapEffort('default', e)).toBe('default');
    expect(mapEffort('minimal', e)).toBe('low');
    expect(mapEffort('max', { current: 'default', levels: ['low', 'medium', 'high'], hasDefault: true })).toBe('high');
    expect(mapEffort('weird', e)).toBe('default');
    expect(mapEffort('high', null)).toBeNull();
  });
  it('steps: the model first, then the effort as the new model offers it', () => {
    expect(modelStep(opusConfig, 'sonnet')).toEqual(['model', 'sonnet']);
    expect(modelStep(opusConfig, 'default')).toBeNull();
    expect(modelStep(opusConfig, 'gone-model')).toBeNull();
    expect(effortStep(opusConfig, 'high')).toEqual(['effort', 'high']);
    expect(effortStep([mode, model(), effort('high')], 'high')).toBeNull();
    expect(effortStep([mode, model(), effort('high')], undefined)).toEqual(['effort', 'default']);
    expect(effortStep(haikuConfig, 'high')).toBeNull();
  });
});

describe('routing a chat by its model', () => {
  const ready = { ready: true, agentId: 'acp_claude_phone' };
  it('a chat that picked Claude Code goes to it; a normal chat does not', () => {
    expect(ccModelFor({ messages: [], acp: { agentId: 'acp_claude_phone', cc: true, model: 'sonnet' } }, {}, ready)).toBe('sonnet');
    expect(ccModelFor({ messages: [{ role: 'user', content: 'x' }] }, { ccPick: 'sonnet' }, ready)).toBeNull();
    expect(ccModelFor({ messages: [], acp: { agentId: 'acp_pc1' } }, { ccPick: 'sonnet' }, ready)).toBeNull();
    // the card's "Claude Code (phone)" chat: its own default model
    expect(ccModelFor({ messages: [], acp: { agentId: 'acp_claude_phone' } }, {}, ready)).toBe('default');
  });
  it('a new chat follows the last pick, only while Claude Code is set up and not in roleplay', () => {
    const conv = { messages: [{ role: 'assistant', content: 'Hi', greeting: true }] };
    expect(ccModelFor(conv, { ccPick: 'haiku' }, ready)).toBe('haiku');
    expect(ccModelFor(conv, { ccPick: 'haiku' }, { ...ready, ready: false })).toBeNull();
    expect(ccModelFor(conv, { ccPick: 'haiku' }, { ...ready, rp: true })).toBeNull();
    expect(ccModelFor(conv, { ccPick: null }, ready)).toBeNull();
    expect(routeToClaudeCode(conv, { ccPick: 'haiku' }, ready)).toBe(true);
    expect(conv.acp).toEqual({ agentId: 'acp_claude_phone', cc: true, model: 'haiku' });
    const normal = { messages: [] };
    expect(routeToClaudeCode(normal, {}, ready)).toBe(false);
    expect(normal.acp).toBeUndefined();
  });
  it('a chat switched to Claude Code gives the new session the chat so far', () => {
    const t = withEarlierTurns([{ role: 'assistant', content: 'Hello', greeting: true }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'now');
    expect(t).toBe('Earlier in this chat (before you joined it, for context):\n\nUser: a\n\nAssistant: b\n\n---\n\nnow');
    expect(withEarlierTurns([], 'now')).toBe('now');
    expect(withEarlierTurns([{ role: 'user', content: 'x'.repeat(50) }], 'q', 10)).toContain('…xxxxxxxxxx\n\n---\n\nq');
  });
});

describe('subscription usage from /usage', () => {
  it('reads every window with its reset time (UTC)', () => {
    const u = parseUsageMarkdown(USAGE_UTC, NOW);
    expect(u.windows).toEqual([
      { key: '5h', label: '5-hour limit', pct: 32, resetsAt: Date.UTC(2026, 10, 14, 15, 0) },
      { key: 'week', label: 'Weekly · all models', pct: 61.5, resetsAt: Date.UTC(2026, 10, 18, 9, 0) },
      { key: 'opus', label: 'Weekly · Opus', pct: 12, resetsAt: Date.UTC(2026, 10, 18, 9, 0) },
      { key: 'sonnet', label: 'Weekly · Sonnet', pct: 0, resetsAt: null },
    ]);
    expect(usageSummary(u)).toBe('5 h: 32% · week: 62%');
    expect(usageSummary(u, ' ')).toBe('5 h 32% · week 62%');
  });
  it('model-scoped windows, escaped names, a GMT+1 Linux', () => {
    const u = parseUsageMarkdown(USAGE_SCOPED, NOW);
    expect(u.windows.map((w) => [w.key, w.label, w.pct])).toEqual([['5h', '5-hour limit', 32], ['week', 'Weekly · all models', 61.5], ['model', 'Weekly · Opus_4 [1m]', 40]]);
    expect(u.windows[0].resetsAt).toBe(Date.UTC(2026, 10, 14, 15, 0));
  });
  it('reset times in other zones and across the new year', () => {
    expect(parseResetText('Nov 14, 7:00 AM PST', NOW)).toBe(Date.UTC(2026, 10, 14, 15, 0));
    expect(parseResetText('Nov 14, 8:30 PM GMT+5:30', NOW)).toBe(Date.UTC(2026, 10, 14, 15, 0));
    expect(parseResetText('Nov 14, 3:00 PM UTC', NOW)).toBe(Date.UTC(2026, 10, 14, 15, 0));
    expect(parseResetText('Jan 2, 12:00 AM UTC', Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 0, 0));
    expect(parseResetText('Nov 14, 3:00 PM Mars/Base', NOW)).toBeNull();
    expect(parseResetText('soon', NOW)).toBeNull();
  });
  it('nothing for an answer without limits (API key sign-in, an error, another shape)', () => {
    expect(parseUsageMarkdown('## Usage\n\n### This session\n\n| Cost |', NOW)).toBeNull();
    expect(parseUsageMarkdown('', NOW)).toBeNull();
    expect(usageSummary(null)).toBe('');
  });
  it('never carries account details', () => {
    const u = parseUsageMarkdown(USAGE_UTC + '\n\nuser@example.com · Org Name', NOW);
    expect(JSON.stringify(u)).not.toMatch(/example\.com|Org Name|max subscription/);
  });
});

describe('ACP client: config options', () => {
  function bridge() {
    const events = [];
    const sent = [];
    let wake = null;
    const push = (m) => (events.push(m), wake?.());
    const agent = (m) => {
      sent.push(m);
      if (m.method === 'initialize') push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } } });
      else if (m.method === 'session/new') push({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', configOptions: opusConfig } });
      else if (m.method === 'session/set_config_option') {
        push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'config_option_update', configOptions: haikuConfig } } });
        push({ jsonrpc: '2.0', id: m.id, result: { configOptions: haikuConfig } });
      } else if (m.method === 'session/close') push({ jsonrpc: '2.0', id: m.id, result: {} });
    };
    const http = async (url, { method, body }) => {
      if (method === 'POST') return agent(JSON.parse(body)), { status: 202, body: '{}' };
      const since = Number(/since=(\d+)/.exec(url)[1]);
      if (events.length <= since) await new Promise((r) => ((wake = r), setTimeout(r, 50)));
      return { status: 200, body: JSON.stringify({ next: events.length, events: events.slice(since) }) };
    };
    return { http, sent };
  }
  it('keeps each session’s configOptions; sets the model with session/set_config_option; closes a session', async () => {
    const { http, sent } = bridge();
    const c = new AcpClient({ url: 'http://127.0.0.1:1', secret: 's', http });
    const ups = [];
    c.onUpdate = (u) => ups.push(readUpdate(u));
    await c.start();
    const sid = await c.newSession('/root');
    expect(readConfig(c.configs.get(sid)).model).toBe('default');
    const after = await c.setConfigOption(sid, 'model', 'haiku');
    expect(readConfig(after).model).toBe('haiku');
    expect(sent.find((m) => m.method === 'session/set_config_option').params).toEqual({ sessionId: 's1', configId: 'model', value: 'haiku' });
    expect(ups.some((u) => u.config)).toBe(true);
    expect(await c.closeSession(sid)).toBe(true);
    expect(c.configs.has(sid)).toBe(false);
    expect(sent.some((m) => m.method === 'session/close')).toBe(true);
    c.close();
  });
});
