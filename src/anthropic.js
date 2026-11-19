// Claude through Anthropic's own API (the official @anthropic-ai/sdk), with the user's own API key from
// platform.claude.com – the way Anthropic allows third-party apps to use Claude (decision 164).
// Chronicle speaks OpenAI chat format inside (system/user/assistant/tool messages, tool_calls, image_url parts);
// this file converts that to the Messages API and the SDK's stream events back to streamChat's callbacks.
// Everything here except runAnthropicStream / listAnthropicModels / goStreamFetch is pure.

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const STREAM_MAX_TOKENS = 64000;
// lets a replayed thinking block that Chronicle's history edits (trimmed tool results, a sliding window, a changed
// system prompt) invalidated be dropped by the API instead of failing the request with a 400
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
// a policy refusal is re-run by the API on a model it picks for that kind of refusal, in the same call
// ("fallbacks: 'default'"); offered for the current models that take it
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const takesFallback = (model) => /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5(-[12])?)$/.test(String(model || ''));
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** The SDK's baseURL from what the user typed: no trailing slash, no /v1 (the SDK adds /v1/messages itself). */
export const anthropicBase = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '') || ANTHROPIC_BASE;

/** Chronicle's effort choice → output_config.effort, only a level the model takes (none → the API's default). */
export function anthropicEffort(effort, levels = EFFORT_LEVELS) {
  if (!effort || !levels?.length) return undefined;
  const e = String(effort).toLowerCase();
  const want = e === 'none' || e === 'minimal' ? 'low' : e;
  if (levels.includes(want)) return want;
  if (want === 'xhigh' && levels.includes('high')) return 'high'; // a model without xhigh: the nearest level below
  if (want === 'max' && levels.includes('high')) return 'high';
  return undefined;
}

/** A models.list() entry → the model entry Chronicle's picker and context limits use. */
export function anthropicModel(p, m) {
  const caps = m.capabilities || null;
  const levels = caps?.effort?.supported ? EFFORT_LEVELS.filter((l) => caps.effort[l]?.supported) : [];
  // without capability data (a manual model name) the current models' surface is assumed: adaptive thinking, all levels
  const adaptive = caps ? !!caps.thinking?.types?.adaptive?.supported : true;
  const effort = caps ? levels : EFFORT_LEVELS;
  const vision = caps ? !!caps.image_input?.supported : true;
  return {
    id: `${p.id}:${m.id}`,
    apiModel: m.id,
    name: m.display_name || m.id,
    source: 'custom',
    providerId: p.id,
    providerName: p.name,
    description: `${p.name} · ${m.id}${m.lifecycle === 'deprecated' ? ' (deprecated)' : ''}`,
    limit: { context: Number(m.max_input_tokens) || Number(p.context) || 200000, output: Number(m.max_tokens) || undefined },
    capabilities: { tools: { supported: p.tools !== false }, reasoning: { supported: adaptive || effort.length > 0, effort } },
    modalities: { input: vision ? ['text', ...IMAGE_TYPES] : ['text'] },
    type: 'chat',
    anthropic: { adaptive, effort, output: Number(m.max_tokens) || undefined },
  };
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x?.type === 'text' ? x.text : '')).join('') : '');
function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return {}; // arguments that are not JSON were already reported back to the model as a failed call
  }
}

/** One image_url part → an image block (data: URLs as base64, http(s) as url); null when it cannot be one. */
export function imageBlock(url) {
  const u = String(url || '');
  const m = u.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (m) {
    const type = (m[1] || '').toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!IMAGE_TYPES.includes(type) || !m[2]) return null;
    return { type: 'image', source: { type: 'base64', media_type: type, data: m[3] } };
  }
  if (/^https?:\/\//i.test(u)) return { type: 'image', source: { type: 'url', url: u } };
  return null;
}

function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out = [];
  for (const part of content || []) {
    if (part?.type === 'text' && part.text) out.push({ type: 'text', text: part.text });
    else if (part?.type === 'image_url') {
      const b = imageBlock(part.image_url?.url ?? part.image_url);
      out.push(b || { type: 'text', text: '[an image in a format Claude does not take]' });
    } else if (part?.type === 'image' && part.source) out.push(part); // already Anthropic-shaped
  }
  return out;
}

/** The thinking blocks (and the order of text / tool_use around them) of a reply, to send back in later turns. */
export function keptBlocks(content) {
  if (!(content || []).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) return null;
  return content
    .map((b) => {
      if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
      if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data };
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name };
      return null;
    })
    .filter(Boolean);
}

/**
 * An assistant turn. Its stored blocks (thinking with signatures) are replayed unchanged when the turn still
 * says what it said then (same text, same tool calls); an edited turn goes as plain text + tool_use, without them.
 */
function assistantBlocks(m) {
  const text = textOf(m.content);
  const calls = (m.tool_calls || []).filter((c) => c?.function?.name);
  const toolUse = (c) => ({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
  const kept = Array.isArray(m.anthropic) ? m.anthropic : null;
  if (kept?.length) {
    const keptText = kept.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const keptIds = kept.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (keptText.trim() === text.trim() && keptIds.join('\n') === calls.map((c) => c.id).join('\n')) {
      const byId = new Map(calls.map((c) => [c.id, c]));
      return kept.map((b) => (b.type === 'tool_use' ? toolUse(byId.get(b.id)) : { ...b })).filter((b) => b.type !== 'text' || b.text);
    }
  }
  const out = [];
  if (text.trim()) out.push({ type: 'text', text });
  calls.forEach((c) => out.push(toolUse(c)));
  return out;
}

/** Tool calls written out as text: for a request without tools (the API refuses tool blocks then). */
function flattenTools(messages) {
  const names = new Map();
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      m.tool_calls.forEach((c) => names.set(c.id, c.function?.name));
      const calls = m.tool_calls.map((c) => `→ ${c.function?.name}(${c.function?.arguments || ''})`).join('\n');
      out.push({ role: 'assistant', content: [textOf(m.content), calls].filter((x) => x.trim()).join('\n') });
    } else if (m.role === 'tool') out.push({ role: 'user', content: `[Result of ${names.get(m.tool_call_id) || 'a tool'}]\n${textOf(m.content) || m.content || ''}` });
    else out.push(m);
  }
  return out;
}

/**
 * Chronicle's OpenAI-style messages → { system, messages, droppedPrefill, hasThinking }.
 * - the leading system messages become the top-level system prompt (kept as one stable block for the cache)
 * - later system messages (notes, post-history instructions) become user-side text: a mid-conversation system
 *   message has placement rules and is not on every model
 * - assistant tool_calls → tool_use blocks; consecutive role:'tool' results → ONE user message of tool_result blocks
 * - a trailing assistant message (roleplay prefill) is dropped: current models refuse prefill with a 400
 */
export function toAnthropicMessages(input, { tools = true } = {}) {
  let msgs = (input || []).filter(Boolean);
  if (!tools) msgs = flattenTools(msgs);
  const sys = [];
  let i = 0;
  for (; i < msgs.length && msgs[i].role === 'system'; i++) if (textOf(msgs[i].content).trim()) sys.push(textOf(msgs[i].content));
  const out = [];
  // the end of the chat history: the per-turn notes after it (memories, the scene sheet – trailing system messages)
  // change every turn, so the cache point goes before them (decision 209)
  let lastHist = msgs.length - 1;
  while (lastHist >= i && msgs[lastHist].role === 'system') lastHist--;
  let histEnd = null;
  const add = (role, blocks) => {
    if (!blocks.length) return;
    const prev = out[out.length - 1];
    // same role twice in a row: one message (tool_result blocks stay first, as the API needs)
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const [k, m] of msgs.slice(i).entries()) {
    const before = out.length ? out[out.length - 1].content.length : 0;
    const countBefore = out.length;
    if (m.role === 'system') {
      const t = textOf(m.content);
      if (t.trim()) add('user', [{ type: 'text', text: `[System note]\n${t}` }]);
    } else if (m.role === 'tool') {
      const c = typeof m.content === 'string' ? m.content : textOf(m.content);
      add('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: c || '(no output)' }]);
    } else if (m.role === 'assistant') add('assistant', assistantBlocks(m));
    else add('user', userBlocks(m.content));
    // the last block this history message added
    if (i + k === lastHist && out.length) {
      const last = out[out.length - 1];
      const added = out.length > countBefore || last.content.length > before;
      if (added) histEnd = last.content[last.content.length - 1];
    }
  }
  let droppedPrefill = false;
  while (out.length && out[out.length - 1].role === 'assistant' && !out[out.length - 1].content.some((b) => b.type === 'tool_use')) {
    out.pop();
    droppedPrefill = true;
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(The conversation starts.)' }] });
  const hasThinking = out.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
  // a dropped prefill took the end of the history with it
  if (histEnd && !out.some((m) => m.content.includes(histEnd))) histEnd = null;
  return { system: sys.join('\n\n'), messages: out, droppedPrefill, hasThinking, histEnd };
}

/** OpenAI-style tool definitions → Anthropic tools. */
export const toAnthropicTools = (tools) =>
  (tools || [])
    .map((t) => t?.function || t)
    .filter((f) => f?.name)
    .map((f) => ({ name: f.name, description: f.description || '', input_schema: f.parameters && f.parameters.type === 'object' ? f.parameters : { type: 'object', properties: {}, ...(f.parameters || {}) } }));

/**
 * The whole request body. Samplers: temperature, top_p, top_k (and min_p / penalties, which the API never had) are
 * left out – current models reject them; max_tokens and stop strings are kept.
 */
export function anthropicParams({ model, messages, tools, effort, samplers, maxTokens, caps = {}, longCache = false }) {
  const useTools = !!tools?.length;
  const conv = toAnthropicMessages(messages, { tools: useTools });
  const out = caps.output || STREAM_MAX_TOKENS;
  const params = {
    model,
    max_tokens: Math.max(1, Math.min(Number(samplers?.max_tokens) || Number(maxTokens) || STREAM_MAX_TOKENS, out)),
    messages: conv.messages,
    cache_control: { type: 'ephemeral' }, // automatic prompt caching of the stable prefix
  };
  // an explicit cache point at the end of the system prompt too (decision 199): the automatic one moves with the last
  // message and looks back 20 blocks at most – a change deep in a long history still finds tools + system cached.
  // Settings › Tools & agent can keep it an hour (dearer to write, for chats with long gaps: schedules, goals).
  const cc = longCache ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  if (conv.system) params.system = [{ type: 'text', text: conv.system, cache_control: cc }];
  // …and one at the end of the chat history, before the per-turn notes that follow it (memories, the scene sheet):
  // the automatic point sits on those notes, which differ next turn, so it never matched again and only tools +
  // system came from the cache (decision 209). Not on a thinking block (it cannot carry one), and only when notes
  // follow (otherwise the automatic point is already there).
  const h = conv.histEnd;
  const last = conv.messages.at(-1)?.content.at(-1);
  if (h && h !== last && !['thinking', 'redacted_thinking'].includes(h.type)) h.cache_control = cc;
  if (caps.adaptive !== false) params.thinking = { type: 'adaptive', display: 'summarized' };
  const e = anthropicEffort(effort, caps.effort || EFFORT_LEVELS);
  if (e) params.output_config = { effort: e };
  const stops = (samplers?.stop || []).filter((s) => typeof s === 'string' && s.trim());
  if (stops.length) params.stop_sequences = stops;
  if (useTools) {
    params.tools = toAnthropicTools(tools);
    params.tool_choice = { type: 'auto' }; // forced any/tool is a 400 on current models
  }
  const dropped = ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'].filter((k) => typeof samplers?.[k] === 'number');
  return { params, droppedPrefill: conv.droppedPrefill, droppedSamplers: dropped, hasThinking: conv.hasThinking };
}

/** The same request with every replayed thinking block taken out (the recovery for a binding 400). */
export function withoutThinking(params) {
  return { ...params, messages: params.messages.map((m) => (m.role === 'assistant' ? { ...m, content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m)).filter((m) => m.content.length) };
}

/** Anthropic usage → the OpenAI-style usage the rest of the app reads (prompt tokens include the cached ones). */
export function usageOf(u) {
  if (!u) return null;
  const read = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + read + write;
  return { prompt_tokens: prompt, completion_tokens: u.output_tokens || 0, total_tokens: prompt + (u.output_tokens || 0), prompt_tokens_details: { cached_tokens: read }, cache_read_input_tokens: read, cache_creation_input_tokens: write };
}

/** Why a reply stopped, in the words streamChat's callers know. */
export const finishOf = (r) => ({ end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', model_context_window_exceeded: 'length', pause_turn: 'stop' })[r] || r || 'incomplete';

export function refusalText(msg) {
  const d = msg?.stop_details || {};
  const cat = d.category ? ` (${String(d.category).replace(/_/g, ' ')})` : '';
  return `Claude declined to answer this${cat}.${d.explanation ? ` ${d.explanation}` : ''} You can rephrase it, or use ⋯ › 🔁 Retry with another model.`;
}

/** A clear message for an SDK error (typed classes, never the message text). A = the SDK's default export. */
export function describeAnthropicError(e, A) {
  const detail = () => {
    const b = e?.error?.error || e?.error || {};
    return `${b.type ? `${b.type}: ` : ''}${b.message || e?.message || ''}`.trim();
  };
  if (A && e instanceof A.AuthenticationError) return `HTTP 401 – Anthropic did not accept the API key. Check the key in Settings › Custom endpoints › Anthropic (Claude): it comes from platform.claude.com › API keys (a claude.ai subscription sign-in cannot be used here).`;
  if (A && e instanceof A.PermissionDeniedError) return `HTTP 403 – this Anthropic key may not do that: ${detail()}`;
  if (A && e instanceof A.NotFoundError) return `HTTP 404 – ${detail()} (is the model name right? Settings › Custom endpoints › Anthropic › Test lists the models your key has)`;
  if (A && e instanceof A.RateLimitError) return `HTTP 429 – Anthropic rate limit reached: ${detail()}. Wait a moment, or check your limits at platform.claude.com.`;
  if (A && e instanceof A.OverloadedError) return `HTTP 529 – Anthropic is overloaded right now (${detail()}); retry shortly.`;
  if (A && e instanceof A.APIConnectionError) return `Network error – could not reach Anthropic (${e.message}).`;
  if (A && e instanceof A.APIError && e.status) return `HTTP ${e.status} – ${detail()}`;
  if (A && e instanceof A.APIError) return detail() || 'Anthropic API error';
  return e?.message || String(e);
}

/**
 * Run one streamed request. handlers as streamChat's: onContent, onReasoning, onToolCallDelta, onToolCalls,
 * onUsage, onDone(reason, info), onError. Returns { cancel() }.
 */
export function runAnthropicStream({ client, A, params, hasThinking, onUsageRecord }, handlers) {
  let stream = null;
  let cancelled = false;
  let finished = false;
  const done = (fn) => {
    if (finished) return;
    finished = true;
    fn();
  };
  let noFallback = false;
  const start = (p, beta) => {
    const fb = !noFallback && takesFallback(p.model);
    if (!beta && !fb) return client.messages.stream(p, { maxRetries: 0 });
    const betas = [...(beta ? [BINDING_BETA] : []), ...(fb ? [FALLBACK_BETA] : [])];
    return client.beta.messages.stream(
      {
        ...p,
        // a request that sends thinking blocks back asks the API to drop any it can no longer verify, not to fail
        ...(beta ? { thinking: { ...p.thinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}),
        ...(fb ? { fallbacks: 'default' } : {}),
        betas,
      },
      { maxRetries: 0 },
    );
  };
  const once = async (p, beta) => {
    let output = false;
    const calls = []; // by content block index
    let thinkingAt = -1;
    stream = start(p, beta);
    try {
      for await (const ev of stream) {
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'tool_use') calls[ev.index] = { id: b.id, name: b.name, arguments: '', closed: false };
          if (b.type === 'thinking' && thinkingAt >= 0 && thinkingAt !== ev.index) handlers.onReasoning?.('\n\n');
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta;
          output = true;
          if (d.type === 'text_delta' && d.text) handlers.onContent?.(d.text);
          else if (d.type === 'thinking_delta' && d.thinking) {
            thinkingAt = ev.index;
            handlers.onReasoning?.(d.thinking);
          } else if (d.type === 'input_json_delta' && calls[ev.index]) {
            calls[ev.index].arguments += d.partial_json || '';
            handlers.onToolCallDelta?.(calls.filter(Boolean).map(({ id, name, arguments: a }) => ({ id, name, arguments: a })));
          }
        } else if (ev.type === 'content_block_stop' && calls[ev.index]) calls[ev.index].closed = true;
      }
      return { msg: await stream.finalMessage(), calls, output };
    } catch (e) {
      e.__output = output;
      throw e;
    }
  };
  (async () => {
    let p = params;
    let beta = hasThinking;
    for (let attempt = 0; ; attempt++) {
      try {
        const { msg, calls } = await once(p, beta);
        if (cancelled) return done(() => handlers.onDone?.('stop', { maxTokens: params.max_tokens }));
        const usage = usageOf(msg.usage);
        if (usage) {
          onUsageRecord?.(usage);
          handlers.onUsage?.(usage);
        }
        if (msg.stop_reason === 'refusal') return done(() => handlers.onError?.(new Error(refusalText(msg))));
        // only tool calls whose input arrived whole (a reply cut by max_tokens can end inside one)
        const list = calls.filter((c) => c && c.closed).map(({ id, name, arguments: a }) => ({ id, name, arguments: a || '{}' }));
        if (list.length) handlers.onToolCalls?.(list);
        const kept = keptBlocks(msg.content);
        return done(() => handlers.onDone?.(finishOf(msg.stop_reason), { maxTokens: params.max_tokens, ...(kept ? { anthropic: kept } : {}) }));
      } catch (e) {
        if (cancelled || (A && e instanceof A.APIUserAbortError) || e?.name === 'AbortError') return done(() => handlers.onDone?.('stop', { maxTokens: params.max_tokens }));
        // a replayed thinking block the API refused (bound to another conversation, an edited history, a signature
        // it cannot read): once, the same request without any thinking blocks
        // the refusal fallback refused as a setting (an account or model without it): once more without it
        if (attempt < 2 && !noFallback && !e.__output && takesFallback(p.model) && A && e instanceof A.BadRequestError && /fallback/i.test(JSON.stringify(e.error || '') + e.message)) {
          noFallback = true;
          continue;
        }
        if (attempt === 0 && !e.__output && hasThinking && A && e instanceof A.BadRequestError && /thinking|signature|block_binding|anthropic-beta|beta/i.test(JSON.stringify(e.error || '') + e.message)) {
          p = withoutThinking(params);
          beta = false;
          continue;
        }
        return done(() => handlers.onError?.(new Error(describeAnthropicError(e, A))));
      }
    }
  })();
  return {
    cancel() {
      cancelled = true;
      try {
        stream?.abort();
      } catch {
        /* already over */
      }
    },
  };
}

/** Every model the key can use (client.models.list() pages through them all), newest first, Opus 5.5 on top. */
export async function listAnthropicModels(client, p) {
  const list = [];
  for await (const m of client.models.list()) if (m?.id && m.lifecycle !== 'retired') list.push(m);
  list.sort((a, b) => (b.id === ANTHROPIC_DEFAULT_MODEL) - (a.id === ANTHROPIC_DEFAULT_MODEL));
  return list.map((m) => anthropicModel(p, m));
}

/**
 * A fetch() for the SDK that goes through the native GoStream plugin (Android): the same HTTP stack every other
 * provider streams through, which keeps going while the app is in the background and needs no CORS.
 */
export function goStreamFetch(GoStream) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const id = `anth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const headers = {};
      new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
      const method = String(init.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') headers['X-Http-Method'] = method;
      const enc = new TextEncoder();
      let ctrl;
      let answered = false;
      let over = false;
      const body = new ReadableStream({
        start: (c) => (ctrl = c),
        cancel: () => stop(),
      });
      const subs = [];
      const cleanup = () => subs.forEach((s) => Promise.resolve(s).then((h) => h?.remove?.()));
      const answer = (res) => {
        answered = true;
        resolve(res);
      };
      const fail = (err) => {
        if (over) return;
        over = true;
        cleanup();
        if (!answered) {
          answered = true;
          reject(err);
        } else
          try {
            ctrl.error(err);
          } catch {
            /* the reader is gone */
          }
      };
      const stop = () => {
        GoStream.cancel({ id }).catch?.(() => {});
        fail(new DOMException('The request was cancelled', 'AbortError'));
      };
      subs.push(GoStream.addListener('response', (e) => e.id === id && !answered && answer(new Response(body, { status: e.status || 200, headers: e.headers || {} }))));
      subs.push(GoStream.addListener('chunk', (e) => e.id === id && !over && ctrl.enqueue(enc.encode(e.data))));
      subs.push(
        GoStream.addListener('done', (e) => {
          if (e.id !== id || over) return;
          over = true;
          cleanup();
          if (!answered) answer(new Response(body, { status: 200 }));
          ctrl.close();
        }),
      );
      subs.push(
        GoStream.addListener('error', (e) => {
          if (e.id !== id || over) return;
          if (e.status && !answered) {
            // an HTTP error: a real response, so the SDK raises its typed error (AuthenticationError…)
            over = true;
            cleanup();
            return answer(new Response(e.body || '', { status: e.status, headers: { 'content-type': 'application/json' } }));
          }
          fail(new TypeError(e.message || `HTTP ${e.status || ''} network error`));
        }),
      );
      if (init.signal) {
        if (init.signal.aborted) return stop();
        init.signal.addEventListener('abort', stop, { once: true });
      }
      Promise.all(subs)
        .then(() => GoStream.start({ id, url: String(url), headers, body: method === 'GET' || init.body == null ? undefined : String(init.body) }))
        .catch((err) => fail(err));
    });
}
