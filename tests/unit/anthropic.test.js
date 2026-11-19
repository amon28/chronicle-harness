// Claude via the official Anthropic SDK (decision 164): the OpenAI-style ⇄ Messages API converters, the effort
// mapping, route selection in streamChat, the model list, and the native fetch adapter. No network: the SDK's
// requests are answered by a stubbed fetch with Anthropic-format SSE.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { anthropicEffort, anthropicModel, anthropicParams, toAnthropicMessages, keptBlocks, usageOf, refusalText, goStreamFetch, anthropicBase, withoutThinking } from '../../src/anthropic.js';
import { streamChat, setModelRoutes, listProviderModels, PROVIDER_PRESETS } from '../../src/api.js';

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = (usage = {}) => ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } } });
const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const delta = (index, d) => ({ type: 'content_block_delta', index, delta: d });
const stop = (index) => ({ type: 'content_block_stop', index });
const end = (stop_reason, extra = {}, usage = { output_tokens: 30 }) => [{ type: 'message_delta', delta: { stop_reason, stop_sequence: null, ...extra }, usage }, { type: 'message_stop' }];

function stubFetch(handler) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    const h = {};
    new Headers(init?.headers || {}).forEach((v, k) => (h[k] = v));
    const call = { url: String(url), method: init?.method, headers: h, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = await handler(call, calls.length);
    if (r instanceof Response) return r;
    return new Response(r, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const provider = { ...PROVIDER_PRESETS.anthropic, id: 'pvA', apiKey: 'sk-ant-test', baseUrl: 'http://mock.local/anthropic' };
const opus = anthropicModel(provider, {
  id: 'claude-opus-5-5',
  display_name: 'Claude Opus 5.5',
  max_input_tokens: 1000000,
  max_tokens: 128000,
  capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } }, thinking: { supported: true, types: { adaptive: { supported: true } } }, image_input: { supported: true } },
});
const run = (opts, extra = {}) =>
  new Promise((resolve) => {
    const out = { content: '', reasoning: '', calls: null, usage: null, deltas: 0 };
    streamChat({}, { model: opus.id, sessionId: 'c1', ...opts }, {
      onContent: (t) => (out.content += t),
      onReasoning: (t) => (out.reasoning += t),
      onToolCallDelta: () => out.deltas++,
      onToolCalls: (c) => (out.calls = c),
      onUsage: (u) => (out.usage = u),
      onDone: (reason, info) => resolve({ ...out, reason, info }),
      onError: (e) => resolve({ ...out, error: e.message }),
      ...extra,
    });
  });

describe('OpenAI-style messages → Anthropic messages', () => {
  it('system on top, tool calls as tool_use, parallel results in ONE user message, images as image blocks', () => {
    const { system, messages, droppedPrefill } = toAnthropicMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'What is in these?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }] },
      { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'toolu_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }, { id: 'toolu_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_a', content: 'A' },
      { role: 'tool', tool_call_id: 'toolu_b', content: 'B' },
      { role: 'user', content: '[Images from view_images]' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'thanks' },
      { role: 'system', content: 'Keep it short.' },
    ]);
    expect(system).toBe('You are helpful.');
    expect(droppedPrefill).toBe(false);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(messages[0].content[2]).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } });
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.txt' } },
    ]);
    // both results in one user message, first, then the note that followed them
    expect(messages[2].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(messages[2].content[1]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_b', content: 'B' });
    // a later system message becomes user-side text after the user's own words
    expect(messages[4].content).toEqual([{ type: 'text', text: 'thanks' }, { type: 'text', text: '[System note]\nKeep it short.' }]);
  });

  it('a roleplay prefill (trailing assistant message) is dropped; the conversation always starts with a user turn', () => {
    const r = toAnthropicMessages([
      { role: 'system', content: 'Card' },
      { role: 'assistant', content: '*waves* Hello traveller.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '{{char}}:' },
    ]);
    expect(r.droppedPrefill).toBe(true);
    expect(r.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hi' }] });
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '*waves* Hello traveller.' }] });
  });

  it('tool arguments are parsed with JSON.parse (escapes and unicode), bad JSON becomes {}', () => {
    const r = toAnthropicMessages([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'w', arguments: '{"p":"a\\/b","s":"\\u00e9"}' } }, { id: 't2', function: { name: 'w', arguments: '{"p":' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
      { role: 'tool', tool_call_id: 't2', content: 'bad arguments' },
    ]);
    expect(r.messages[1].content[0].input).toEqual({ p: 'a/b', s: 'é' });
    expect(r.messages[1].content[1].input).toEqual({});
  });

  it('without tools in the request, tool calls and results are written out as text', () => {
    const r = toAnthropicMessages(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', function: { name: 'ls', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'a.txt' },
        { role: 'user', content: 'summarize' },
      ],
      { tools: false },
    );
    expect(JSON.stringify(r.messages)).not.toMatch(/tool_use|tool_result/);
    expect(r.messages[1].content[0].text).toBe('ok\n→ ls({})');
    expect(r.messages[2].content[0].text).toBe('[Result of ls]\na.txt');
  });

  it('thinking blocks kept on a stored reply go back unchanged, in their order; an edited reply goes without them', () => {
    const kept = keptBlocks([
      { type: 'thinking', thinking: 'Need the file.', signature: 'sig1' },
      { type: 'text', text: 'Reading it.', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'x' } },
    ]);
    expect(kept).toEqual([{ type: 'thinking', thinking: 'Need the file.', signature: 'sig1' }, { type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file' }]);
    const hist = (content) => [
      { role: 'user', content: 'read x' },
      { role: 'assistant', content, anthropic: kept, tool_calls: [{ id: 'toolu_1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'X' },
    ];
    const same = toAnthropicMessages(hist('Reading it.'));
    expect(same.hasThinking).toBe(true);
    expect(same.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'Need the file.', signature: 'sig1' },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'x' } },
    ]);
    const edited = toAnthropicMessages(hist('Reading it (edited).'));
    expect(edited.hasThinking).toBe(false);
    expect(edited.messages[1].content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(keptBlocks([{ type: 'text', text: 'no thinking' }])).toBeNull();
    expect(withoutThinking({ messages: same.messages }).messages[1].content.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });
});

describe('request parameters', () => {
  it('adaptive thinking (summarized), automatic caching, auto tool choice, no samplers, stop strings and max length kept', () => {
    const { params, droppedSamplers } = anthropicParams({
      model: 'claude-opus-5-5',
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      effort: 'high',
      samplers: { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.1, repetition_penalty: 1.1, max_tokens: 900, stop: ['\nUser:', '  '] },
      caps: opus.anthropic,
    });
    expect(params).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 900, system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }], cache_control: { type: 'ephemeral' }, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' }, stop_sequences: ['\nUser:'], tool_choice: { type: 'auto' } });
    expect(params.tools).toEqual([{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
    for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty']) expect(params).not.toHaveProperty(k);
    expect(JSON.stringify(params)).not.toMatch(/budget_tokens/);
    expect(droppedSamplers).toEqual(['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty']);
  });

  it('an explicit cache point at the end of the system prompt; an hour when asked', () => {
    const p5 = anthropicParams({ model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'x' }] }).params;
    expect(p5.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    const p60 = anthropicParams({ model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'x' }], longCache: true }).params;
    expect(p60.system.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(anthropicParams({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).params.system).toBeUndefined();
  });
  it('max_tokens: 64000 for streaming, capped by the model; no thinking for a model without adaptive thinking', () => {
    expect(anthropicParams({ model: 'm', messages: [{ role: 'user', content: 'x' }], caps: opus.anthropic }).params.max_tokens).toBe(64000);
    const small = anthropicParams({ model: 'm', messages: [{ role: 'user', content: 'x' }], effort: 'high', caps: { adaptive: false, effort: [], output: 8192 } }).params;
    expect(small.max_tokens).toBe(8192);
    expect(small).not.toHaveProperty('thinking');
    expect(small).not.toHaveProperty('output_config');
  });

  it("maps Chronicle's effort selector onto output_config.effort", () => {
    expect(anthropicEffort(undefined)).toBeUndefined(); // "default": the API's own (medium on Opus 5.5)
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => anthropicEffort(e))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(anthropicEffort('minimal')).toBe('low');
    expect(anthropicEffort('none')).toBe('low');
    expect(anthropicEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
    expect(anthropicEffort('high', [])).toBeUndefined();
    expect(anthropicEffort('bogus')).toBeUndefined();
  });

  it('a models.list() entry → picker entry with its context window, effort levels and image input', () => {
    expect(opus).toMatchObject({ id: 'pvA:claude-opus-5-5', apiModel: 'claude-opus-5-5', name: 'Claude Opus 5.5', providerName: 'Anthropic (Claude)', limit: { context: 1000000, output: 128000 }, capabilities: { reasoning: { supported: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] } } });
    expect(opus.modalities.input).toContain('image/png');
    const haiku = anthropicModel(provider, { id: 'claude-haiku-4-5', max_input_tokens: 200000, capabilities: { effort: { supported: false }, thinking: { supported: true, types: { adaptive: { supported: false } } }, image_input: { supported: true } } });
    expect(haiku.anthropic).toEqual({ adaptive: false, effort: [], output: undefined });
    expect(haiku.limit.context).toBe(200000);
  });

  it('usage: prompt tokens include cache reads and writes; cached tokens reported', () => {
    expect(usageOf({ input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5 })).toMatchObject({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 }, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 });
    expect(anthropicBase('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com');
    expect(refusalText({ stop_details: { category: 'cyber', explanation: 'Looks like malware.' } })).toMatch(/declined.*\(cyber\)\. Looks like malware\..*Retry with another model/);
  });
});

describe('streamChat routes Claude models through the SDK', () => {
  setModelRoutes([opus], [provider]);

  it('streams text, summarized thinking, a tool call and usage (cache reads included); keeps the thinking block', async () => {
    const calls = stubFetch(() =>
      sse([
        start({ cache_read_input_tokens: 800, cache_creation_input_tokens: 40 }),
        block(0, { type: 'thinking', thinking: '', signature: '' }),
        delta(0, { type: 'thinking_delta', thinking: 'The user wants a file.' }),
        delta(0, { type: 'signature_delta', signature: 'sigA' }),
        stop(0),
        block(1, { type: 'text', text: '' }),
        delta(1, { type: 'text_delta', text: 'Writing ' }),
        delta(1, { type: 'text_delta', text: 'it.' }),
        stop(1),
        block(2, { type: 'tool_use', id: 'toolu_9', name: 'write_file', input: {} }),
        delta(2, { type: 'input_json_delta', partial_json: '{"path":"a.txt",' }),
        delta(2, { type: 'input_json_delta', partial_json: '"content":"hi"}' }),
        stop(2),
        ...end('tool_use'),
      ]),
    );
    const r = await run({
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'make a.txt' }],
      tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: {} } } }],
      temperature: 0.9,
      reasoningEffort: 'low',
    });
    expect(calls[0].url).toBe('http://mock.local/anthropic/v1/messages');
    expect(calls[0].headers.authorization).toBe('Bearer sk-ant-test'); // SDK 1.8 sends the key this way
    expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    // Opus 5.5: a refusal is re-run by the API on a fallback model it picks (server-side, same call)
    expect(calls[0].headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(calls[0].body.fallbacks).toBe('default');
    expect(calls[0].body).toMatchObject({ model: 'claude-opus-5-5', stream: true, system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }], thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' }, cache_control: { type: 'ephemeral' }, max_tokens: 64000 });
    expect(calls[0].body).not.toHaveProperty('temperature');
    expect(r.error).toBeUndefined();
    expect(r.content).toBe('Writing it.');
    expect(r.reasoning).toBe('The user wants a file.');
    expect(r.calls).toEqual([{ id: 'toolu_9', name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' }]);
    expect(JSON.parse(r.calls[0].arguments)).toEqual({ path: 'a.txt', content: 'hi' });
    expect(r.deltas).toBeGreaterThan(0);
    expect(r.reason).toBe('tool_calls');
    expect(r.usage).toMatchObject({ prompt_tokens: 852, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 800 } });
    expect(r.info.anthropic).toEqual([{ type: 'thinking', thinking: 'The user wants a file.', signature: 'sigA' }, { type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 'toolu_9', name: 'write_file' }]);
  });

  it('a request that sends thinking back asks for drop_block (beta header); a binding 400 is retried once without thinking', async () => {
    const calls = stubFetch((c, n) =>
      n === 1
        ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block.' } }), { status: 400, headers: { 'content-type': 'application/json' } })
        : sse([start(), block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'Done.' }), stop(0), ...end('end_turn')]),
    );
    const kept = [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file' }];
    const r = await run({
      messages: [
        { role: 'user', content: 'read x' },
        { role: 'assistant', content: 'Reading.', anthropic: kept, tool_calls: [{ id: 'toolu_1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'X' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
    });
    expect(calls[0].headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01');
    expect(calls[0].body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(calls[0].body.messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig' });
    expect(calls[0].body).not.toHaveProperty('betas');
    expect(calls[1].headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01'); // without thinking, the fallback stays
    expect(JSON.stringify(calls[1].body.messages)).not.toMatch(/"thinking"/);
    expect(r).toMatchObject({ content: 'Done.', reason: 'stop' });
  });

  it('a refusal shows a clear message (category, explanation) instead of an empty reply', async () => {
    stubFetch(() => sse([start(), ...end('refusal', { stop_details: { type: 'refusal', category: 'bio', explanation: 'This could enable harm.' } }, { output_tokens: 0 })]));
    const r = await run({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.error).toMatch(/^Claude declined to answer this \(bio\)\. This could enable harm\./);
    expect(r.error).toMatch(/Retry with another model/);
  });

  it('typed errors: a bad key says to check the key; a rate limit says so; never retried by the SDK itself', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const r = await run({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.error).toMatch(/did not accept the API key.*platform\.claude\.com/);
    stubFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }));
    const r2 = await run({ messages: [{ role: 'user', content: 'x' }] });
    expect(r2.error).toMatch(/^HTTP 429 – Anthropic rate limit reached: rate_limit_error: Number of requests/);
    expect(calls.length).toBe(1);
  });

  it('refusal fallback: only on the models that take it; a 400 about it is retried once without it', async () => {
    const { takesFallback } = await import('../../src/anthropic.js');
    expect(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-opus-5'].every(takesFallback)).toBe(true);
    expect(['claude-haiku-5-5', 'claude-opus-4-8', 'claude-sonnet-5'].some(takesFallback)).toBe(false);
    const calls = stubFetch((c, n) =>
      n === 1
        ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not available for this account' } }), { status: 400, headers: { 'content-type': 'application/json' } })
        : sse([start(), block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'Hi.' }), stop(0), ...end('end_turn')]),
    );
    const r = await run({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.error).toBeUndefined();
    expect(r.content).toBe('Hi.');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.fallbacks).toBeUndefined();
    expect(calls[1].headers['anthropic-beta']).toBeUndefined();
  });

  it('max_tokens: a tool call cut off mid-input is not run', async () => {
    stubFetch(() => sse([start(), block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'Writing' }), stop(0), block(1, { type: 'tool_use', id: 'toolu_x', name: 'write_file', input: {} }), delta(1, { type: 'input_json_delta', partial_json: '{"path":"a' }), ...end('max_tokens')]));
    const r = await run({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'write_file' } }] });
    expect(r.calls).toBeNull();
    expect(r.reason).toBe('length');
  });

  it('other providers never receive the stored thinking blocks', async () => {
    const other = { id: 'pvO', name: 'Other', baseUrl: 'http://other.local/v1', apiKey: 'k', via: 'browser' };
    setModelRoutes([opus, { id: 'pvO:m', apiModel: 'm', source: 'custom', providerId: 'pvO' }], [provider, other]);
    const calls = stubFetch(() => 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const r = await new Promise((resolve) => streamChat({}, { model: 'pvO:m', sessionId: 's', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', anthropic: [{ type: 'thinking', thinking: 't', signature: 's' }] }, { role: 'user', content: 'c' }] }, { onDone: resolve, onError: resolve }));
    expect(r).toBe('stop');
    expect(calls[0].url).toBe('http://other.local/v1/chat/completions');
    expect(JSON.stringify(calls[0].body)).not.toMatch(/anthropic|signature/);
    setModelRoutes([opus], [provider]);
  });

  it('the provider lists its models with client.models.list() (all pages), Opus 5.5 first', async () => {
    const calls = stubFetch((c) => {
      const after = new URL(c.url).searchParams.get('after_id');
      const page = after ? { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: null, lifecycle: 'active', type: 'model' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' } : { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: null, lifecycle: 'active', type: 'model' }], has_more: true, first_id: 'claude-sonnet-5-5', last_id: 'claude-sonnet-5-5' };
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await listProviderModels(provider);
    expect(r.error).toBeNull();
    expect(r.models.map((m) => m.id)).toEqual(['pvA:claude-opus-5-5', 'pvA:claude-sonnet-5-5']);
    expect(calls[0].url).toMatch(/^http:\/\/mock\.local\/anthropic\/v1\/models/);
    expect(calls[0].headers.authorization).toBe('Bearer sk-ant-test'); // SDK 1.8 sends the key this way
  });

  it('when the list cannot be read: the error, and the typed-in / default model so the picker is not empty', async () => {
    stubFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const r = await listProviderModels(provider);
    expect(r.error).toMatch(/did not accept the API key/);
    expect(r.models.map((m) => m.apiModel)).toEqual(['claude-opus-5-5']);
    const none = await listProviderModels({ ...provider, apiKey: '' });
    expect(none.error).toMatch(/Add your Anthropic API key/);
  });
});

describe('goStreamFetch (the native plugin as the SDK fetch)', () => {
  function fakePlugin(script) {
    const ls = {};
    const plugin = {
      started: null,
      cancelled: [],
      addListener: (ev, fn) => Promise.resolve(((ls[ev] ||= []).push(fn), { remove: () => (ls[ev] = ls[ev].filter((f) => f !== fn)) })),
      start: async (o) => {
        plugin.started = o;
        setTimeout(() => script((ev, e) => (ls[ev] || []).forEach((f) => f({ id: o.id, ...e }))), 0);
      },
      cancel: async (o) => plugin.cancelled.push(o.id),
    };
    return plugin;
  }
  it('streams the body; headers and POST body are passed on', async () => {
    const g = fakePlugin((emit) => {
      emit('response', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      emit('chunk', { data: 'event: a\n\n' });
      emit('chunk', { data: 'event: b\n\n' });
      emit('done', {});
    });
    const res = await goStreamFetch(g)('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('event: a\n\nevent: b\n\n');
    expect(g.started).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': 'k' }, body: '{"a":1}' });
  });
  it('an HTTP error becomes a real response (so the SDK raises its typed error); a network error rejects', async () => {
    const g = fakePlugin((emit) => emit('error', { status: 401, body: '{"type":"error"}' }));
    const res = await goStreamFetch(g)('u', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(g.started.body).toBeUndefined();
    const n = fakePlugin((emit) => emit('error', { message: 'UnknownHostException' }));
    await expect(goStreamFetch(n)('u', {})).rejects.toThrow(/UnknownHost/);
  });
  it('abort cancels the native request', async () => {
    const g = fakePlugin(() => {});
    const ctrl = new AbortController();
    const p = goStreamFetch(g)('u', { signal: ctrl.signal, method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(g.cancelled.length).toBe(1);
  });
});
