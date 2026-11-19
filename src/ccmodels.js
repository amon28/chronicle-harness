// Claude Code in Linux as models in the normal model picker (decision 165). Pure: what the ACP adapter's
// `configOptions` offer (models, effort), which chat goes to Claude Code, and the subscription usage that the
// adapter's local "/usage" command answers with. Nothing here signs in or reads Claude Code's credentials: the user's
// own Claude Code CLI answers, over ACP (claudecode.js, acp-ui.js).
//
// Verified in @agentclientprotocol/claude-agent-acp 0.107.0 (dist/): session/new, session/load and
// session/set_config_option answer with `configOptions` – a "model" select (id "model", category "model"), an
// "effort" select (id "effort", category "thought_level") only when the current model supports effort, "mode",
// and sometimes Fast mode / ultracode / agent. The model and effort are set with session/set_config_option
// { sessionId, configId, value }; there is no session/set_model in its v1 handlers. A config_option_update
// session update carries the whole new list. "/usage" (exactly) is run by Claude Code locally – no model turn – and
// comes back as agent_message_chunk text: the adapter's formatUsageResponse markdown, "**5-hour limit** — **32%** ·
// Resets Nov 14, 3:00 PM UTC", one line per window.

/** A Chronicle model id for a Claude Code model value ("cc:opus"). */
export const CC_PREFIX = 'cc:';
export const ccModelId = (value) => CC_PREFIX + String(value || 'default');
export const isCcModelId = (id) => typeof id === 'string' && id.startsWith(CC_PREFIX);
export const ccValueOf = (id) => (isCcModelId(id) ? id.slice(CC_PREFIX.length) : null);
export const CC_SECTION = 'Claude Code (your subscription)';

/** Select options can be flat or grouped ({ group, name, options: [...] }). */
const flat = (opts) => (Array.isArray(opts) ? opts.flatMap((o) => (o && Array.isArray(o.options) ? o.options : [o])) : []).filter((o) => o && typeof o.value === 'string');
const findOpt = (configOptions, id, category) => (Array.isArray(configOptions) ? configOptions : []).find((o) => o && (o.id === id || (category && o.category === category)) && o.type === 'select');

/** configOptions → { models: [{ value, name, description }], model, effort: { current, levels, hasDefault } | null } */
export function readConfig(configOptions) {
  const m = findOpt(configOptions, 'model', 'model');
  const e = findOpt(configOptions, 'effort', 'thought_level');
  const models = flat(m?.options).map((o) => ({ value: o.value, name: String(o.name || o.value).slice(0, 80), ...(o.description ? { description: String(o.description).slice(0, 160) } : {}) }));
  const ev = flat(e?.options).map((o) => o.value);
  return {
    models,
    model: typeof m?.currentValue === 'string' ? m.currentValue : null,
    effort: e ? { current: typeof e.currentValue === 'string' ? e.currentValue : 'default', levels: ev.filter((v) => v !== 'default'), hasDefault: ev.includes('default') } : null,
  };
}

/** The model list kept between app runs: what the last session offered, and which effort levels each model had. */
export function mergeModelCache(cache, configOptions) {
  const cfg = readConfig(configOptions);
  const out = { models: cache?.models || [], effort: { ...(cache?.effort || {}) }, at: cache?.at || 0 };
  if (cfg.models.length) out.models = cfg.models;
  if (cfg.model) out.effort[cfg.model] = cfg.effort ? cfg.effort.levels : [];
  if (cfg.models.length || cfg.model) out.at = Date.now();
  return out;
}

/** The picker's entries: Chronicle model objects (not in state.models – helpers and fallbacks never pick them). */
export function ccModelEntries(cache) {
  const list = cache?.models?.length ? cache.models : [{ value: 'default', name: 'Claude Code – default model', placeholder: true }];
  return list.map((o) => {
    const levels = cache?.effort?.[o.value] || [];
    return {
      id: ccModelId(o.value),
      name: o.name,
      ccValue: o.value,
      source: 'claudecode',
      ...(o.description ? { description: o.description } : {}),
      ...(o.placeholder ? { placeholder: true } : {}),
      capabilities: { reasoning: { supported: levels.length > 0, effort: levels } },
    };
  });
}

const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Chronicle's 🧠 effort for this model → the adapter's effort value. The chip offers the adapter's own levels, so
 * this is mostly the same word; a level the current model does not have goes to the nearest one, and none
 * ("default") is Claude Code's own setting. → a value to set, or null when the model has no effort option.
 */
export function mapEffort(want, effort) {
  if (!effort) return null;
  const levels = effort.levels || [];
  if (!want || want === 'default') return effort.hasDefault ? 'default' : null;
  if (levels.includes(want)) return want;
  const i = ORDER.indexOf(want);
  if (i < 0 || !levels.length) return effort.hasDefault ? 'default' : null;
  let best = null;
  for (const l of levels) {
    const j = ORDER.indexOf(l);
    if (j < 0) continue;
    if (!best || Math.abs(j - i) < Math.abs(ORDER.indexOf(best) - i) || (Math.abs(j - i) === Math.abs(ORDER.indexOf(best) - i) && j < ORDER.indexOf(best))) best = l;
  }
  return best || (effort.hasDefault ? 'default' : null);
}

/** What to send so the session runs `model`: [configId, value] or null (already, or not offered). */
export function modelStep(configOptions, model) {
  if (!model) return null;
  const cfg = readConfig(configOptions);
  if (!cfg.models.length || cfg.model === model) return null;
  return cfg.models.some((o) => o.value === model) ? ['model', model] : null;
}
/** …and the effort step after it (checked against the options as the model step left them). */
export function effortStep(configOptions, want) {
  const cfg = readConfig(configOptions);
  const v = mapEffort(want, cfg.effort);
  return v && v !== cfg.effort.current ? ['effort', v] : null;
}

/**
 * Which Claude Code model a chat uses, or null for a normal chat. A chat picked for Claude Code keeps it
 * (`conv.acp.cc`); the card's "Claude Code (phone)" chats keep their agent (its default model, or one picked); a chat with
 * no messages of its own yet follows the last pick (settings.ccPick), as new chats follow the last model – but not
 * roleplay or group chats (Claude Code gets the message text, not a character's prompt), and only while Claude Code
 * is set up (`ready`).
 */
export function ccModelFor(conv, settings, { ready = false, agentId = 'acp_claude_phone', rp = false } = {}) {
  if (!conv) return null;
  if (conv.acp) return conv.acp.agentId === agentId ? conv.acp.model || 'default' : null;
  if (!ready || rp || !settings?.ccPick) return null;
  const own = (conv.messages || []).some((m) => !m.greeting);
  return own ? null : settings.ccPick;
}

/** At send: make the chat a Claude Code chat when its model says so. → true when it goes to Claude Code. */
export function routeToClaudeCode(conv, settings, opts = {}) {
  const v = ccModelFor(conv, settings, opts);
  if (!v) return false;
  if (!conv.acp) conv.acp = { agentId: opts.agentId || 'acp_claude_phone', cc: true, model: v };
  return true;
}

/**
 * The first prompt of a new Claude Code session in a chat that already has messages (a chat switched over, or back):
 * the conversation so far, so Claude Code is not starting blind. The newest part is kept when it is long.
 */
export function withEarlierTurns(messages, text, max = 12000) {
  const earlier = (messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.greeting && typeof m.content === 'string' && m.content.trim());
  if (!earlier.length) return text;
  let body = earlier.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`).join('\n\n');
  if (body.length > max) body = '…' + body.slice(-max);
  return `Earlier in this chat (before you joined it, for context):\n\n${body}\n\n---\n\n${text}`;
}

// ---------- subscription usage (the adapter's "/usage" markdown) ----------
const unescape = (s) => s.replace(/\\([\\`*_[\]<>|])/g, '$1');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ZONES = { UTC: 0, GMT: 0, Z: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4, AKST: -9, AKDT: -8, HST: -10 };

/** "Nov 14, 3:00 PM UTC" (Intl "en", short month, the zone of Linux) → epoch ms, or null. The year is the one that puts it nearest to now. */
export function parseResetText(text, now = Date.now()) {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})[\s  ]*([AP]M)?[\s  ]*(.*)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let h = Number(m[3]) % (m[5] ? 12 : 24);
  if (m[5] && m[5].toUpperCase() === 'PM') h += 12;
  const zone = m[6].trim().toUpperCase();
  let off;
  const g = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (g) off = (g[1] === '-' ? -1 : 1) * (Number(g[2]) * 60 + Number(g[3] || 0));
  else if (zone in ZONES) off = ZONES[zone] * 60;
  else if (!zone) off = 0;
  else return null;
  const y = new Date(now).getUTCFullYear();
  const at = (yr) => Date.UTC(yr, mon, Number(m[2]), h, Number(m[4])) - off * 60000;
  return [y - 1, y, y + 1].map(at).sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
}

/** Which window a label is: '5h', 'week', 'opus', 'sonnet' or a model-scoped week ('model'). */
function windowKey(label) {
  const l = label.toLowerCase();
  if (/5-hour|five.hour|session/.test(l)) return '5h';
  if (/all models|^weekly$/.test(l)) return 'week';
  if (l === 'weekly · opus') return 'opus';
  if (l === 'weekly · sonnet') return 'sonnet';
  return 'model';
}

/**
 * The "/usage" reply → { windows: [{ key, label, pct, resetsAt }], at } or null when it has no limits in it (an
 * API-key sign-in, an answer in another shape, an error). The account e-mail / organisation are never in it and are
 * not looked for; the plan line ("Claude max subscription usage") is left out too.
 */
export function parseUsageMarkdown(md, now = Date.now()) {
  const windows = [];
  for (const line of String(md || '').split('\n')) {
    const m = /^\*\*(.+?)\*\*\s*[—–-]\s*\*\*(\d+(?:\.\d+)?)%\*\*(?:\s*·\s*Resets\s+(.+))?\s*$/.exec(line.trim());
    if (!m) continue;
    const label = unescape(m[1]).trim();
    const pct = Math.max(0, Math.min(100, Number(m[2])));
    windows.push({ key: windowKey(label), label, pct, resetsAt: m[3] ? parseResetText(m[3], now) : null });
  }
  return windows.length ? { windows, at: now } : null;
}

const pctText = (p) => `${Math.round(p)}%`;
/** "5 h: 32% · week: 61%" for the picker's section header (sep ': '), "5 h 32% · week 61%" for the drawer (sep ' '). */
export function usageSummary(u, sep = ': ') {
  if (!u?.windows?.length) return '';
  const five = u.windows.find((w) => w.key === '5h');
  const week = u.windows.find((w) => w.key === 'week');
  return [five && `5 h${sep}${pctText(five.pct)}`, week && `week${sep}${pctText(week.pct)}`].filter(Boolean).join(' · ');
}
