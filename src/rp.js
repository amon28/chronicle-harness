// Roleplay prompt building, modelled on how SillyTavern assembles Chat Completion prompts from
// Character Card V2/V3 data:
//   main prompt (card system_prompt, {{original}} = default) → world info (before) → user persona →
//   char description → personality → scenario → world info (after) → example dialogues →
//   chat history (+ Character's Note / Author's Note / world info injected at a depth) →
//   post-history instructions (card, {{original}} = default) → group nudge.

export const DEFAULT_MAIN = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.";
export const RP_GUIDE = `Stay in character as {{char}} at all times. Write only {{char}}'s actions, dialogue and thoughts – never speak, act or decide for {{user}}. Be descriptive and immersive, keep the story moving, and stay consistent with the character, the scenario and earlier events.`;
export const DEFAULT_PHI = '';
export const GROUP_NUDGE = '[Write the next reply only as {{char}}.]';
export const CONTINUE_NUDGE = "[Continue {{char}}'s last message from exactly where it stopped, without repeating any of it.]";
export const IMPERSONATE_PROMPT = "[Write the next message from {{user}}'s point of view, in first person, matching {{user}}'s voice and the chat's style so far. Write only {{user}}'s words and actions – nothing for {{char}} – and no commentary.]";
export const EXAMPLE_START = '[Example chat – shows how {{char}} talks; it is not part of the story]';
export const CHAT_START = '[Start of the roleplay]';

// ---------- macros ----------
const pad = (n) => String(n).padStart(2, '0');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function roll(spec) {
  const m = String(spec).trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i) || String(spec).trim().match(/^()(\d+)()$/);
  if (!m) return spec;
  const n = Math.min(100, Number(m[1] || 1));
  const sides = Math.max(1, Number(m[2]));
  let t = 0;
  for (let i = 0; i < n; i++) t += 1 + Math.floor(Math.random() * sides);
  return String(t + Number(m[3] || 0));
}

function splitArgs(s) {
  if (s.includes('::')) return s.split('::');
  return s.split(',');
}

const ago = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return 'a few seconds';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h > 1 ? 's' : ''}`;
  return `${Math.round(h / 24)} days`;
};

/**
 * Expand SillyTavern-style macros. ctx: { char, user, persona, description, personality, scenario,
 * firstMessage, charPrompt, charInstruction, depthPrompt, original, lastMessage, lastUserMessage,
 * lastCharMessage, idleMs, group, seed }
 */
const splitVar = (arg) => String(arg).split('::').map((x, i) => (i === 0 ? x.trim() : x));

export function expandMacros(text, ctx = {}) {
  if (!text || !text.includes('{') && !/<(BOT|USER)>/i.test(text)) return text || '';
  let out = String(text);
  // comments: {{// …}} (single line) – removed
  out = out.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
  // the date/time ones are slow to format, so they're only worked out when the text uses them
  let nowD = null;
  const now = () => (nowD ||= new Date());
  const simple = {
    char: ctx.char,
    user: ctx.user,
    persona: ctx.persona,
    description: ctx.description,
    personality: ctx.personality,
    scenario: ctx.scenario,
    charfirstmessage: ctx.firstMessage,
    charprompt: ctx.charPrompt,
    charinstruction: ctx.charInstruction,
    chardepthprompt: ctx.depthPrompt,
    mesexamplesraw: ctx.mesExamples,
    mesexamples: ctx.mesExamples,
    original: ctx.original,
    group: ctx.group || ctx.char,
    charifnotgroup: ctx.group ? '' : ctx.char,
    lastmessage: ctx.lastMessage,
    lastusermessage: ctx.lastUserMessage,
    lastcharmessage: ctx.lastCharMessage,
    get time() {
      return now().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    get date() {
      return now().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    },
    get weekday() {
      return now().toLocaleDateString([], { weekday: 'long' });
    },
    get isotime() {
      return `${pad(now().getHours())}:${pad(now().getMinutes())}`;
    },
    get isodate() {
      return `${now().getFullYear()}-${pad(now().getMonth() + 1)}-${pad(now().getDate())}`;
    },
    idleduration: ctx.idleMs != null ? ago(ctx.idleMs) : 'just now',
    idle_duration: ctx.idleMs != null ? ago(ctx.idleMs) : 'just now',
    newline: '\n',
    space: ' ',
    noop: '',
  };
  // {{if cond}}…{{else}}…{{/if}} – innermost first, so they can nest; the branch not taken is dropped before
  // anything in it runs (a {{setvar}} there does nothing). cond: a macro name (true when it is not empty),
  // var::name / globalvar::name, either with == != > < >= <= and a value, and ! in front to negate.
  const value = (ref) => {
    const r = ref.trim();
    const vm = /^(global)?var::(.+)$/i.exec(r);
    if (vm) {
      const v = (vm[1] ? ctx.globalVars : ctx.vars)?.[vm[2].trim()];
      return v == null ? '' : String(v);
    }
    const k = r.toLowerCase();
    return k in simple && simple[k] != null ? String(simple[k]) : '';
  };
  const test = (cond) => {
    let c = cond.trim();
    const neg = c.startsWith('!');
    if (neg) c = c.slice(1);
    const cm = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/.exec(c);
    let ok;
    if (cm) {
      const a = value(cm[1]);
      const b = cm[3].trim().replace(/^(["'])(.*)\1$/, '$2');
      const na = Number(a);
      const nb = Number(b);
      const num = a.trim() !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb);
      const cmp = num ? na - nb : a.toLowerCase().localeCompare(b.toLowerCase());
      ok = { '==': cmp === 0, '!=': cmp !== 0, '>': cmp > 0, '<': cmp < 0, '>=': cmp >= 0, '<=': cmp <= 0 }[cm[2]];
    } else ok = value(c).trim() !== '';
    return neg ? !ok : ok;
  };
  const IF = /\{\{\s*if\s+((?:(?!\}\})[\s\S])+?)\s*\}\}((?:(?!\{\{\s*if\s)[\s\S])*?)\{\{\s*\/if\s*\}\}/i;
  for (let guard = 0; guard < 100 && IF.test(out); guard++)
    out = out.replace(IF, (m, cond, body) => {
      const [yes, no = ''] = body.split(/\{\{\s*else\s*\}\}/i);
      return test(cond) ? yes : no;
    });
  let pickN = 0;
  out = out.replace(/\{\{\s*([a-zA-Z_]+)(?:(::|:)([\s\S]*?))?\s*\}\}/g, (m, name, sep, arg) => {
    const k = name.toLowerCase();
    if (k === 'random' && arg != null) {
      const opts = splitArgs(arg);
      return opts[Math.floor(Math.random() * opts.length)].trim();
    }
    if (k === 'pick' && arg != null) {
      // stable for this chat and position
      const opts = splitArgs(arg);
      return opts[hash(`${ctx.seed || ''}:${pickN++}:${arg}`) % opts.length].trim();
    }
    if (k === 'roll' && arg != null) return roll(arg);
    // chat variables (SillyTavern): {{setvar::name::value}} {{getvar::name}} {{addvar::name::n}} {{incvar::name}} {{decvar::name}},
    // and the same with "global" for variables shared by all chats. Setting returns nothing; the store is the caller's object.
    const vm = /^(set|get|add|inc|dec)(global)?var$/.exec(k);
    if (vm) {
      const store = vm[2] ? ctx.globalVars : ctx.vars;
      const [vname, ...rest] = splitVar(arg || '');
      if (!store || !vname) return '';
      const cur = store[vname];
      if (vm[1] === 'get') return cur == null ? '' : String(cur);
      if (vm[1] === 'set') store[vname] = rest.join('::');
      else {
        const by = vm[1] === 'inc' ? 1 : vm[1] === 'dec' ? -1 : rest.join('::');
        const a = Number(cur ?? 0);
        const b = Number(by);
        store[vname] = Number.isFinite(a) && Number.isFinite(b) && String(by).trim() !== '' ? +(a + b).toFixed(6) : String(cur ?? '') + String(by);
      }
      return '';
    }
    if (k === 'trim') return '\u0000TRIM\u0000';
    if (k in simple && simple[k] != null) return String(simple[k]);
    if (k in simple) return '';
    return m; // unknown macro: leave as is
  });
  out = out.replace(/\s*\u0000TRIM\u0000\s*/g, '');
  out = out.replace(/<BOT>/gi, ctx.char || '').replace(/<USER>/gi, ctx.user || '');
  return out;
}

// ---------- example dialogues ----------
/** mes_example → [[{role, content}, …], …] (one array per <START> block). */
export function parseExamples(mes, charName, userName) {
  if (!mes || !mes.trim()) return [];
  const blocks = mes
    .split(/<START>/i)
    .map((b) => b.trim())
    .filter(Boolean);
  const userRx = new RegExp(`^(?:\\{\\{user\\}\\}|<USER>|${esc(userName)}):\\s?`, 'i');
  const charRx = new RegExp(`^(?:\\{\\{char\\}\\}|<BOT>|${esc(charName)}):\\s?`, 'i');
  return blocks
    .map((block) => {
      const msgs = [];
      for (const line of block.split('\n')) {
        if (userRx.test(line)) msgs.push({ role: 'user', content: line.replace(userRx, '') });
        else if (charRx.test(line)) msgs.push({ role: 'assistant', content: line.replace(charRx, '') });
        else if (msgs.length) msgs[msgs.length - 1].content += '\n' + line;
        else msgs.push({ role: 'assistant', content: line });
      }
      return msgs.map((m) => ({ ...m, content: m.content.trim() })).filter((m) => m.content);
    })
    .filter((b) => b.length);
}

function esc(s) {
  return String(s || '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Insert {role, content} injections into a message list at "depth" (0 = after the last message). */
export function injectAtDepth(history, injections) {
  const out = [...history];
  // deeper first so indexes of shallower ones stay correct
  for (const inj of [...injections].sort((a, b) => b.depth - a.depth)) {
    if (!inj.content?.trim()) continue;
    let at = Math.max(0, out.length - Math.max(0, inj.depth | 0));
    // never split an assistant tool call from its tool results
    while (at > 0 && out[at]?.role === 'tool') at--;
    out.splice(at, 0, { role: inj.role || 'system', content: inj.content });
  }
  return out;
}
