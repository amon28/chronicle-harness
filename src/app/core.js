// Shared core: app state, preferences, persona lookups and small DOM helpers.
// Imports nothing from the other app modules, so it is always fully initialised first.
import { Capacitor } from '@capacitor/core';
import { isCcModel, setModelRoutes } from '../api.js';
import { isErrorText, logError } from '../errorlog.js';
import { loadSettings, saveSettings, cache, setSaveErrorHandler, setSecretsLostHandler } from '../store.js';
import { renderMarkdown as mdRender } from '../markdown.js';
import { ensureSnippets } from '../snippets.js';
import { cardPrompt } from '../cards.js';
import { addNewBuiltins, ensurePersonas } from '../personas.js';
import { addBuiltinSkills } from '../skills.js';
import { setPromptSource } from '../prompts.js';
import { canUsePhoneFolder } from '../phonefolder.js';
/** android_intent: on Android, or with the test stand-in. */
const canOpenApps = () => !!globalThis.__ocmIntents || Capacitor.isNativePlatform();
/** calendar, contacts, location: on Android, or with the test stand-in. */
const canUseDevice = () => !!globalThis.__ocmDevice || Capacitor.isNativePlatform();
/** phone_status, phone_control, take_photo: on Android, or with the test stand-in. */
const canUsePhoneCtl = () => !!globalThis.__ocmPhone || Capacitor.isNativePlatform();
import { canControlBrowser } from '../browsercontrol.js';
import { canUseShell } from '../shell.js';
import { applyToolset } from '../toolset.js';
import { privateFlags } from '../private.js';
/** notifications, texts & calls, place triggers: each on Android (or with its test stand-in) and switched on. */
const privateOn = () => privateFlags(state.settings, { notify: !!globalThis.__ocmNotify || Capacitor.isNativePlatform(), messages: !!globalThis.__ocmMessages || Capacitor.isNativePlatform(), geofence: !!globalThis.__ocmGeofence || Capacitor.isNativePlatform() });

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const state = {
  settings: loadSettings(),
  models: cache('models') || [],
  convs: [],
  current: null, // conversation object
  runs: new Map(), // chat id → { cancel } for every chat that is writing right now (they keep going in the background)
  unseen: new Set(), // chats that finished a reply while you were in another chat (blue dot)
  asking: new Set(), // chats with a question waiting for you
  queues: new Map(), // chat id → messages waiting to be sent when the reply finishes: [{ id, text, pending, urgent }]
  stopped: new Set(), // chats whose reply YOU stopped (their queue waits)
  pending: [], // attachments: {kind:'image', src} | {kind:'file', name, text, ...}
};
// the reply of the chat you are looking at (null when it is idle)
Object.defineProperty(state, 'stream', { get: () => state.runs.get(state.current?.id) || null, enumerable: true });
setPromptSource(() => state.settings.prompts);
if (ensurePersonas(state.settings)) saveSettings(state.settings);
if (!state.settings.zenFreeMigrated) {
  // Zen's free models refuse Go keys outside the official OpenCode apps → off unless turned on again
  state.settings.prefs = { ...state.settings.prefs, zenFree: false };
  state.settings.zenFreeMigrated = true;
  saveSettings(state.settings);
}
if (!Array.isArray(state.settings.providers)) state.settings.providers = [];
// Chub blocks the native client (Cloudflare) – existing Chub endpoints switch to browser requests
for (const pv of state.settings.providers) if (!pv.via && /chub\.ai/i.test(pv.baseUrl || '')) Object.assign(pv, { via: 'browser', auth: 'ch-api-key' });
setModelRoutes(state.models, state.settings.providers); // cached list: route Zen / custom models before the first refresh
if (!Array.isArray(state.settings.memories)) state.settings.memories = [];
if (ensureSnippets(state.settings)) saveSettings(state.settings);
if (!Array.isArray(state.settings.lorebooks)) state.settings.lorebooks = [];
if (!Array.isArray(state.settings.skills)) state.settings.skills = [];
if (!Array.isArray(state.settings.mcpServers)) state.settings.mcpServers = [];
if (!Array.isArray(state.settings.pcServers)) state.settings.pcServers = [];
{
  const newPersonas = addNewBuiltins(state.settings);
  const newSkills = addBuiltinSkills(state.settings); // (both run: no short-circuit)
  if (newPersonas || newSkills) saveSettings(state.settings);
}
// ---------- your persona(s): who you are in roleplay ({{user}} / {{persona}}) ----------
if (!Array.isArray(state.settings.userPersonas) || !state.settings.userPersonas.length) {
  state.settings.userPersonas = [{ id: 'up_default', name: (state.settings.prefs?.userName || '').trim() || 'User', description: '' }];
  state.settings.defaultUserPersonaId = 'up_default';
  saveSettings(state.settings);
}
const userPersonaById = (id) => state.settings.userPersonas.find((u) => u.id === id);
const userPersona = (conv = state.current) => userPersonaById(conv?.userPersonaId) || userPersonaById(state.settings.defaultUserPersonaId) || state.settings.userPersonas[0];
const userName = (conv) => (userPersona(conv)?.name || '').trim() || 'User';
// card personas imported before the structured prompt existed: switch them to card mode
for (const p of state.settings.personas) {
  if (p.card && p.cardMode == null && typeof p.card.description === 'string' && p.prompt === cardPrompt(p.card)) p.cardMode = true;
}
const lorebookById = (id) => state.settings.lorebooks.find((b) => b.id === id);
const memoryOn = (conv = state.current) => pref('useMemory') && !conv?.noMemory;
// Two sides of the app: 💬 Chats (assistants, agents) and 🎭 Roleplay (characters, groups)
const rpPersonaFlag = (p) => !!(p?.cardMode || p?.rp || ['roleplay', 'narrator'].includes(p?.id));
const convIsRp = (c) =>
  c?.group?.members?.length ? c.group.members.some((id) => rpPersonaFlag(state.settings.personas.find((p) => p.id === id))) : rpPersonaFlag(state.settings.personas.find((p) => p.id === c?.personaId));
const toolsOn = (conv = state.current) => conv?.tools ?? chatPersona(conv)?.tools ?? (convIsRp(conv) ? pref('toolsRp') : pref('tools'));
const enabledTools = (conv = state.current) => applyToolset(enabledToolsAll(conv), chatPersona(conv)?.toolset);
const enabledToolsAll = (conv = state.current) => ({ web: pref('toolWeb'), python: pref('toolPython'), files: true, phone: canUsePhoneFolder() && pref('toolPhone'), intents: canOpenApps() && pref('toolIntents'), device: canUseDevice() && pref('toolDevice'), phonectl: canUsePhoneCtl() && pref('toolPhoneCtl'), private: privateOn(), skills: (state.settings.agentSkills || []).filter((k) => k.enabled !== false), delegate: pref('toolDelegate'), creator: pref('toolCreate'), browser: canControlBrowser() && pref('toolBrowser'), shell: canUseShell() && pref('toolShell'), preview: canControlBrowser() && pref('toolPreview'), modAuthor: !!(pref('modTools') || chatPersona(conv)?.modTools), autonomy: true, goal: conv?.goal || null, planMode: !!conv?.planMode, plan: conv?.plan || null, advisor: !!pref('advisorModel') && (state.models.some((m) => m.id === pref('advisorModel')) || (isCcModel(pref('advisorModel')) && !!hooks.ccJobModels?.().length)), claudecode: (pref('toolClaudeCode') && hooks.ccTaskInfo?.(conv)) || false });

// ---------- preferences ----------
const pref = (k) => state.settings.prefs?.[k] ?? PREF_DEFAULTS[k];
const PREF_DEFAULTS = { thinking: 'stream', compactStyle: 'both', checkWork: true, shellGuard: true, bypassDefault: false, advisorModel: '', textSize: 'm', enterSends: false, showStats: true, showTimes: true, updateCheck: true, notifyDone: true, autoResume: true, proactive: false, proactiveCap: 3, quietFrom: '22:00', quietTo: '08:00', autoContinue: true, ttsAuto: false, ttsDialogue: true, ttsSkipActions: false, ttsRate: 1, ttsEngine: '', ttsVoice: '', episodes: true, episodeEvery: 16, highlight: true, useMemory: true, learn: true, learnEvery: 3, crossRecall: false, learnModel: 'auto', tools: true, toolWeb: true, toolPython: true, maxSteps: 20, wrapUp: true, leanTools: 'auto', pyTimeout: 120, codeCollapse: 20, codeWrap: false, searchProvider: 'auto', autoTitle: true, autoCompact: true, compactAt: 0.8, outputStyle: 'default', showGoUsage: true, showClaudeUsage: true, perfTrace: false, memLimit: 12, smartMemory: false, toolPhone: true, toolIntents: true, toolDevice: true, toolPhoneCtl: true, modTools: false, fallbackModel: '', toolDelegate: true, toolClaudeCode: false, lazyTools: true, toolCreate: true, localModel: false, dailyBudgetM: 0, toolBrowser: false, tracker: false, trackerFields: '', toolShell: false, toolPreview: true, helperModel: 'auto', agentMode: 'ask', ctxLimitRp: 0, ctxLimitOther: 0, storyMemory: true, storyEvery: 16, storyModel: 'auto', userName: '', theme: 'system', iconPack: 'line', accent: '', toolsRp: false, mode: 'chat', rpColors: true, rpAction: '', rpQuote: '', tint: true, chatBg: 'none', rpBg: 'none', bgDim: 72, rpImpersonate: '', rpNames: false, rpNoEmoji: false, rpChoices: false, rpPrefill: '', rpNote: '', rpNoteDepth: 4, rpNoteRole: 'system', rpTrim: false, rpFixMarks: true, rpLore: true, rpRecall: true };
// The roleplay colours were stored even when never changed (the Settings form saves every field), as the dark theme's
// values – on the light theme those are unreadable (2.4:1 and 1.8:1). Those two values count as "not picked".
const OLD_RP_DEFAULTS = { rpAction: '#9aa4b2', rpQuote: '#f0b35a' };
/** The roleplay colour you picked ('' = the theme's default). */
const rpColor = (k) => {
  const v = String(pref(k) || '').toLowerCase();
  return v && v !== OLD_RP_DEFAULTS[k] ? v : '';
};
const ACCENTS = ['', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4'];
function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty('--fs', { s: '14px', m: '16px', l: '18px', xl: '20px' }[pref('textSize')] || '16px');
  document.body.classList.toggle('hide-stats', !pref('showStats'));
  document.body.classList.toggle('hide-times', !pref('showTimes'));
  document.body.classList.toggle('hide-go-usage', !pref('showGoUsage'));
  // theme
  const theme = pref('theme');
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const accent = pref('accent');
  if (accent) {
    root.dataset.accent = '1';
    root.style.setProperty('--accent-c', accent);
  } else {
    delete root.dataset.accent;
    root.style.removeProperty('--accent-c');
  }
  // roleplay colours: only a colour you picked is set; otherwise the theme's own default (style.css --rp-*-def)
  for (const [k, v] of [['--rp-action', rpColor('rpAction')], ['--rp-quote', rpColor('rpQuote')]]) {
    if (v) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  }
  if (pref('tint')) root.dataset.tint = '1';
  else delete root.dataset.tint;
  // chat background
  // (older versions had one background for everything: it becomes the roleplay one, and chats start without)
  const sp = state.settings.prefs;
  if (sp && sp.chatBg !== undefined && sp.rpBg === undefined) {
    sp.rpBg = sp.chatBg;
    if (sp.chatBg === 'card') sp.chatBg = 'none';
  }
  queueMicrotask(() => hooks.applyChatArt?.()); // pictures (character art / your photo) go on their own layer; later, as this also runs while core.js loads
  // browser/status bar colours
  const dark = theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : theme !== 'light';
  const bgColor = getComputedStyle(root).getPropertyValue('--bg').trim() || '#0b0b0c';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bgColor);
  if (Capacitor.isNativePlatform()) {
    import('@capacitor/core').then(({ SystemBars }) => SystemBars?.setStyle?.({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {}));
  }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyPrefs());
applyPrefs();

// ---------- personas ----------
const personas = () => state.settings.personas;
const personaById = (id) => personas().find((p) => p.id === id);
const defaultChatPersona = () => {
  const p = personaById(state.settings.defaultPersonaId);
  return p && !rpPersonaFlag(p) ? p : personas().find((x) => !rpPersonaFlag(x)) || personas()[0];
};
const defaultRpPersona = () => {
  const p = personaById(state.settings.defaultRpPersonaId);
  return p && rpPersonaFlag(p) ? p : personas().find((x) => x.cardMode) || personas().find(rpPersonaFlag) || personas()[0];
};
let appMode = 'chat'; // set from prefs at boot
const setAppMode = (m) => (appMode = m);
// late-bound callbacks other modules register (core imports nothing from the app modules)
const hooks = {};
const defaultPersona = () => (appMode === 'rp' ? defaultRpPersona() : defaultChatPersona());
const chatPersona = (conv = state.current) => personaById(conv?.personaId) || defaultPersona();
const isGroup = (conv = state.current) => !!conv?.group?.members?.length;
const groupMembers = (conv = state.current) => (conv?.group?.members || []).map(personaById).filter(Boolean);
/** The character card as used in this chat: the persona's card with this chat's own overrides on top. */
const cardFor = (p, conv = state.current) => {
  const base = p?.card || {};
  const o = conv && !conv.group && p?.id === conv.personaId ? conv.cardOverride : null;
  return o ? { ...base, ...o } : base;
};
const chatPrompt = (conv = state.current) => (conv?.systemPrompt != null ? conv.systemPrompt : chatPersona(conv)?.prompt || '');

// a failed save (storage full, IndexedDB unavailable) must never be silent
let saveErrShown = 0;
setSecretsLostHandler(() => setTimeout(() => toast('🔑 Your saved API keys could not be unlocked on this device (e.g. after restoring to a new phone). Please enter them again in Settings.', 8000), 1500));
setSaveErrorHandler((e) => {
  if (Date.now() - saveErrShown < 10000) return;
  saveErrShown = Date.now();
  const full = /quota|full|space/i.test(String(e?.name) + String(e?.message));
  setTimeout(() => toast(full ? '⚠️ Phone storage is full – your last changes could not be saved. Free some space or delete big chats/files.' : `⚠️ Could not save settings: ${e?.message || e}`, 7000), 0);
});

// ---------- helpers ----------
function toast(msg, ms = 2600) {
  // an error message vanishes after a few seconds: the error log keeps it (decision 177)
  if (isErrorText(msg)) logError('message', msg, { conv: state.current?.id, title: state.current?.title });
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const mdOpts = (streaming) => ({ highlight: pref('highlight'), streaming, collapseLines: Number(pref('codeCollapse')) || 0, wrap: pref('codeWrap'), rp: pref('rpColors') && convIsRp(state.current) });
// finished messages render the same every time (switching chats, retries, scrolling) – keep the HTML
const mdCache = new Map();
const renderMarkdown = (text, streaming) => {
  const opts = mdOpts(streaming);
  if (streaming || !text || text.length > 60000) return mdRender(text, opts);
  const key = JSON.stringify(opts) + '\u0000' + text;
  let html = mdCache.get(key);
  if (html === undefined) {
    html = mdRender(text, opts);
    mdCache.set(key, html);
    if (mdCache.size > 400) mdCache.delete(mdCache.keys().next().value);
  } else {
    mdCache.delete(key);
    mdCache.set(key, html); // most recently used last
  }
  return html;
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

const currentModel = () => state.models.find((m) => m.id === state.settings.model);
/** Can this model see images? As the model list says. */
const supportsImages = (m) => !!m?.modalities?.input?.some((x) => x.startsWith('image'));
/**
 * The 🧠 levels a model takes, as OpenCode's list gives them. "off" too for an OpenCode Go model that can switch its
 * thinking off (reasoning.toggle) and runs on the Anthropic-style API – the way OpenCode's own client switches it off
 * (decision 204). A model that lists "none" already has its off.
 */
const effortOptions = (m) => {
  const r = m?.capabilities?.reasoning;
  if (!r?.supported) return [];
  const levels = Array.isArray(r.effort) ? r.effort : [];
  const off = r.toggle === true && !!m.api?.messages && !m.source && !levels.includes('none') ? ['off'] : [];
  return [...off, ...levels];
};

function fmtTokens(n) {
  if (n == null) return '';
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'K';
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUsage(u) {
  if (!u) return '';
  const parts = [];
  if (u.usage) {
    const inT = u.usage.prompt_tokens ?? u.usage.input_tokens;
    const outT = u.usage.completion_tokens ?? u.usage.output_tokens;
    if (inT != null) parts.push(`${fmtTokens(inT)} in`);
    if (inT > 0 && u.usage.cached_tokens != null) parts.push(`${Math.round((100 * u.usage.cached_tokens) / inT)}% cached`);
    if (outT != null) parts.push(`${fmtTokens(outT)} out`);
  }
  // output tokens per second while it was writing (thinking included); the wait for the first token is apart
  if (u.speed?.ms >= 200 && u.speed.out > 0) parts.push(`${(u.speed.out / (u.speed.ms / 1000)).toFixed(u.speed.out / (u.speed.ms / 1000) < 10 ? 1 : 0)} tok/s`);
  if (u.speed?.ttft != null) parts.push(`${(u.speed.ttft / 1000).toFixed(1)} s to first`);
  const a = u.opencode?.allowance ?? u.opencode;
  if (typeof a === 'number') parts.push(`$${a.toFixed(4)}`);
  else if (a && typeof a === 'object') {
    const cost = a.cost ?? a.spent ?? a.used;
    const left = a.remaining ?? a.left;
    if (typeof cost === 'number') parts.push(`$${cost.toFixed(4)}`);
    if (typeof left === 'number') parts.push(`$${left.toFixed(2)} left`);
  }
  return parts.join(' · ');
}

export { cardFor, $, ACCENTS, rpColor, PREF_DEFAULTS, appMode, applyPrefs, chatPersona, chatPrompt, convIsRp, copyText, currentModel, defaultChatPersona, defaultPersona, defaultRpPersona, effortOptions, el, enabledTools, enabledToolsAll, fmtTokens, fmtUsage, groupMembers, hooks, isGroup, lorebookById, mdOpts, memoryOn, personaById, personas, pref, renderMarkdown, rpPersonaFlag, setAppMode, state, supportsImages, toast, toolsOn, uid, userName, userPersona, userPersonaById };
