import { trackSites } from '../perf.js';
import { setIconPack } from '../icons.js';
// The Settings sheet and its sub-screens: appearance, saved tools, MCP, OpenCode on PC, custom endpoints,
// usage history, backup & restore.
import { Capacitor } from '@capacitor/core';
import { streamChat, needsProxy, setModelRoutes, PROVIDER_PRESETS, listProviderModels, httpRequest, hasBalance, providerBalance, hasSpend, providerSpend } from '../api.js';
import { conversations, saveSettings, secureStorageActive, art } from '../store.js';
import { fmtBytes } from '../files.js';
import { renderMarkdown as mdRender, hydrateRich } from '../markdown.js';
import { cleanOsmUrl } from '../osm.js';
import { listTools as mcpListTools, setAuthSaver } from '../mcp.js';
import { signIn, waitRedirect } from '../mcpauth.js';
import { sandbox, deleteWorkspace, workspaceSummaries } from '../sandbox.js';
import { workspaces } from '../store.js';
import { streamBackup, readBackupFile, applyBackup } from '../backup.js';
import { usageSummary, clearUsage, chatSpend, sourceSpend, todayTokens } from '../usage.js';
import { DEFAULT_MAIN, RP_GUIDE, IMPERSONATE_PROMPT } from '../rp.js';
import { ensurePersonas } from '../personas.js';
import { COMPACT_CHOICES, compactLabel } from '../compactat.js';
import { COMPACT_STYLES, compactStyleOf } from '../foldcontext.js';
import { canUseShell, runShell, shellStatus } from '../shell.js';
import { HOME_TAR, MOVE_DIR, cleanHomeCmd, homeStatusCmd, packHomeCmd, parseHomeStatus, unpackHomeCmd } from '../movedata.js';
import { markDeleted, newChat, openDrawer, openSheet, refreshUsage, selectConv } from './chatlist.js';
import { refreshModels } from './composer.js';
import { $, hooks, ACCENTS, rpColor, applyPrefs, defaultChatPersona, defaultPersona, defaultRpPersona, el, fmtTokens, pref, renderMarkdown, rpPersonaFlag, state, toast, uid, userName, userPersona } from './core.js';
import { canExportLinux, canPickToCache, canUsePhoneFolder, exportLinuxFile, pickFileToCache, pickIntoLinux } from '../phonefolder.js';
import { fillSamplerBox, readSamplerBox, stopStream } from './engine.js';
import { capturePreset, fillPresetPage } from './rppresets-ui.js';
import { appBuild, fillLearnModelSelect, setPref, shareStream, updateToolsChip } from './extras.js';
import { fillCtxSelect, fillPersonaSelect } from './personas-ui.js';
import { messagesEl, modelName, renderMessages, updateHeader } from './render.js';
import { PROMPT_DEFS } from '../prompts.js';
import { labelFastModelOption } from './info.js';

// ---------- settings ----------
// ---------- settings navigation: a menu of categories → one page at a time ----------
const SET_TITLES = { account: '🔑 Account & models', chat: '💬 Chats', shortcuts: '⚡ Shortcuts & recipes', rp: '🎭 Roleplay', rppreset: '🎛 Roleplay presets', memory: '🧠 Memory', tools: '🛠 Tools & agent', connect: '🔌 Connections', voice: '🔊 Voice', notify: '🔔 Notifications & background', look: '🎨 Appearance', prompts: '📝 Prompts', data: '💾 Data' };
let setPage = null;
function showSettingsPage(page) {
  setPage = page || null;
  if (setPage === 'prompts') renderPromptsPage();
  if (setPage === 'voice') hooks.openVoiceSettings?.();
  $('#set-nav').hidden = !!setPage;
  document.querySelectorAll('.set-page').forEach((x) => (x.hidden = x.dataset.page !== setPage));
  $('#set-back').hidden = !setPage;
  $('#set-title').textContent = setPage ? SET_TITLES[setPage] : 'Settings';
  $('#settings-sheet .sheet-card').scrollTop = 0;
}
document.querySelectorAll('.set-item').forEach((b) => (b.onclick = () => showSettingsPage(b.dataset.page)));
$('#set-back').onclick = () => showSettingsPage(null);

// ---------- Settings › Prompts: every built-in instruction, editable ----------
const PROMPT_GROUPS = { chat: '💬 Chats & assistants', rp: '🎭 Roleplay', group: '👥 Group chats & @mentions' };
// prompts that already live on the Roleplay page (shown here as shortcuts)
const RP_PAGE_PROMPTS = [
  ['Pre-history (main) prompt', '#pref-rp-main', 'rpMain'],
  ['Post-history instructions', '#pref-phi', 'rpPhi'],
  ['Impersonation prompt', '#pref-rp-imp', 'rpImpersonate'],
  ['Prompt note', '#pref-rp-note', 'rpNote'],
];
let promptTab = 'chat';
function renderPromptsPage() {
  const list = $('#prompts-list');
  list.innerHTML = '';
  const q = $('#prompts-search').value.trim().toLowerCase();
  const custom = state.settings.prompts || {};
  // tabs instead of one long scroll; a search looks through all of them
  const tabs = $('#prompts-tabs');
  tabs.hidden = !!q;
  tabs.innerHTML = '';
  for (const [g, label] of Object.entries(PROMPT_GROUPS)) {
    const n = PROMPT_DEFS.filter((d) => d.group === g && typeof custom[d.key] === 'string' && custom[d.key] !== d.default).length;
    const b = el('button', 'insp-tab' + (g === promptTab ? ' active' : ''), label.replace(/ &.*|, .*/, ''));
    if (n) b.append(el('span', 'mode-count', String(n)));
    b.onclick = () => {
      promptTab = g;
      renderPromptsPage();
    };
    tabs.append(b);
  }
  for (const [g, label] of Object.entries(PROMPT_GROUPS)) {
    if (!q && g !== promptTab) continue;
    const defs = PROMPT_DEFS.filter((d) => d.group === g && (!q || (d.title + ' ' + d.help + ' ' + (custom[d.key] ?? d.default)).toLowerCase().includes(q)));
    const extra = g === 'rp' ? RP_PAGE_PROMPTS.filter(([t]) => !q || t.toLowerCase().includes(q)) : [];
    if (!defs.length && !extra.length) continue;
    if (q) list.append(el('h3', 'section', label));
    for (const d of defs) {
      const edited = typeof custom[d.key] === 'string' && custom[d.key] !== d.default;
      const box = el('details', 'prompt-item' + (edited ? ' edited' : ''));
      const sum = el('summary');
      sum.append(el('span', 'prompt-title', d.title));
      if (edited) sum.append(el('span', 'badge', 'edited'));
      box.append(sum, el('p', 'hint', d.help));
      if (d.vars?.length) box.append(el('p', 'hint dim', 'Placeholders: ' + d.vars.map((v) => `{${v}}`).join(' ')));
      const ta = el('textarea', 'field mono');
      ta.rows = Math.min(16, Math.max(3, Math.ceil((custom[d.key] ?? d.default).length / 60)));
      ta.value = custom[d.key] ?? d.default;
      ta.placeholder = d.default || '(empty)';
      ta.dataset.prompt = d.key;
      const reset = el('button', 'ghost-btn small', 'Reset to default');
      reset.disabled = !edited;
      ta.addEventListener('input', () => {
        const prompts = (state.settings.prompts ||= {});
        if (ta.value === d.default) delete prompts[d.key];
        else prompts[d.key] = ta.value;
        const on = d.key in prompts;
        box.classList.toggle('edited', on);
        reset.disabled = !on;
        let badge = sum.querySelector('.badge');
        if (on && !badge) sum.append((badge = el('span', 'badge', 'edited')));
        if (!on) badge?.remove();
        clearTimeout(promptSaveTimer);
        promptSaveTimer = setTimeout(() => saveSettings(state.settings), 400);
      });
      reset.onclick = () => {
        ta.value = d.default;
        ta.dispatchEvent(new Event('input'));
        toast('Reset to the original');
      };
      box.append(ta, reset);
      list.append(box);
    }
    for (const [title, sel] of extra) {
      const b = el('button', 'prompt-link', `${title} – on the Roleplay prompts page ›`);
      b.onclick = () => {
        showSettingsPage('rppreset');
        setTimeout(() => {
          $(sel).scrollIntoView({ block: 'center' });
          $(sel).focus();
        }, 50);
      };
      list.append(b);
    }
  }
  if (!list.children.length) list.append(el('p', 'hint', 'No prompts match.'));
}
let promptSaveTimer = null;
$('#prompts-search').addEventListener('input', renderPromptsPage);

// auto-save: every change in Settings is applied right away
let setSaveTimer = null;
// before the roleplay page shows another preset: what was typed for this one is saved into it first
hooks.flushSettings = () => {
  clearTimeout(setSaveTimer);
  readSettingsForm();
};
const autoSave = () => {
  clearTimeout(setSaveTimer);
  setSaveTimer = setTimeout(() => {
    readSettingsForm();
    updateToolsChip();
  }, 350);
};
$('#settings-sheet').addEventListener('input', (e) => e.target.closest('.set-page') && !e.target.closest('[data-page="prompts"]') && autoSave());
$('#settings-sheet').addEventListener('change', (e) => e.target.closest('.set-page') && !e.target.closest('[data-page="prompts"]') && autoSave());
// key / workspace changes refresh models and usage once you leave the field
['#api-key', '#workspace-id', '#pref-zenfree'].forEach((id) =>
  $(id).addEventListener('change', () => {
    readSettingsForm();
    refreshModels();
    refreshUsage(true);
  }),
);

function openSettings(page) {
  showSettingsPage(typeof page === 'string' ? page : !state.settings.apiKey ? 'account' : null);
  const s = state.settings;
  $('#api-key').value = s.apiKey;
  // the OpenCode Go card opens by itself while there is no key; its summary says what is set
  $('#ocg-box').open = !s.apiKey;
  $('#ocg-sum').textContent = s.apiKey ? `Key saved${s.workspaceId ? ' · usage meters on' : ''}${pref('zenFree') ? ' · Zen free models' : ''}` : 'No key yet – add your API key here';
  $('#proxy-url').value = s.proxyUrl;
  $('#workspace-id').value = s.workspaceId || '';
  $('#pref-thinking').value = pref('thinking');
  $('#pref-textsize').value = pref('textSize');
  $('#pref-theme').value = pref('theme');
  renderLearned();
  $('#pref-icons').value = pref('iconPack');
  $('#pref-tint').checked = pref('tint');
  $('#pref-bg').value = pref('chatBg');
  $('#pref-bg-rp').value = pref('rpBg');
  $('#pref-bg-dim').value = pref('bgDim');
  renderAccentRow();
  const bgKinds = [pref('chatBg'), pref('rpBg')];
  $('#bg-photo-row').hidden = !bgKinds.some((k) => ['image', 'card', 'avatar'].includes(k));
  $('#bg-photo').hidden = !bgKinds.includes('image');
  $('#pref-enter').checked = pref('enterSends');
  $('#pref-autotitle').checked = pref('autoTitle');
  $('#pref-phi').value = pref('rpPhi') || '';
  $('#pref-rp-note').value = pref('rpNote') || '';
  $('#pref-rp-note-depth').value = pref('rpNoteDepth');
  $('#pref-rp-note-role').value = pref('rpNoteRole');
  $('#pref-rp-prefill').value = pref('rpPrefill') || '';
  $('#pref-rp-imp').value = pref('rpImpersonate') || '';
  $('#pref-rp-imp').placeholder = IMPERSONATE_PROMPT;
  $('#pref-rp-names').checked = pref('rpNames');
  $('#pref-rp-noemoji').checked = pref('rpNoEmoji');
  $('#pref-rp-choices').checked = pref('rpChoices');
  $('#pref-rp-trim').checked = pref('rpTrim');
  $('#pref-rp-fixmarks').checked = pref('rpFixMarks');
  $('#pref-rp-lore').checked = pref('rpLore');
  $('#pref-rp-recall').checked = pref('rpRecall');
  $('#pref-tracker').checked = pref('tracker');
  $('#pref-tracker-fields').value = pref('trackerFields') || '';
  fillSamplerBox('rps', state.settings.rpSamplers || {});
  $('#pref-rp-main').value = pref('rpMain') || '';
  $('#pref-rp-main').placeholder = DEFAULT_MAIN + '\n' + RP_GUIDE;
  fillPresetPage(state.settings.rpPresetId || ''); // the roleplay fields show the default preset
  fillCtxSelect($('#pref-ctx-rp'), pref('ctxLimitRp'));
  fillCtxSelect($('#pref-ctx-other'), pref('ctxLimitOther'));
  $('#pref-story').checked = pref('storyMemory');
  $('#pref-story-every').value = String(pref('storyEvery'));
  labelFastModelOption();
  $('#pref-story-model').value = pref('storyModel');
  $('#me-summary').textContent = `${userName()}${userPersona()?.description ? ' – ' + userPersona().description.slice(0, 60) : ''}`;
  $('#pref-autocompact').checked = pref('autoCompact');
  {
    const fill = (sel, opts, v) => {
      sel.innerHTML = '';
      for (const [k, label] of opts) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = label;
        sel.append(o);
      }
      sel.value = v;
    };
    fill($('#pref-compact-at'), COMPACT_CHOICES, String(pref('compactAt')));
    fill($('#pref-compact-style'), COMPACT_STYLES, compactStyleOf(pref('compactStyle')));
    const mid = state.settings.model;
    $('#compact-model-name').textContent = state.models.find((m) => m.id === mid)?.name || mid || 'this model';
    const own = state.settings.compactAtModel?.[mid];
    fill($('#pref-compact-model'), [['', `Same as above (${compactLabel(pref('compactAt'))})`], ...COMPACT_CHOICES.map(([k, l]) => [k, l.replace(' (default)', '')])], own != null ? String(own) : '');
  }
  $('#pref-stats').checked = pref('showStats');
  $('#pref-go-usage').checked = pref('showGoUsage');
  $('#pref-claude-usage').checked = pref('showClaudeUsage');
  $('#pref-notify').checked = pref('notifyDone');
  $('#pref-auto-resume').checked = pref('autoResume');
  $('#pref-proactive').checked = pref('proactive');
  $('#pref-quiet-from').value = pref('quietFrom');
  $('#pref-quiet-to').value = pref('quietTo');
  $('#pref-proactive-cap').value = String(pref('proactiveCap'));
  $('#proactive-opts').hidden = !pref('proactive');
  hooks.device?.status?.().then((r) => ($('#battery-hint').hidden = !r || r.batteryFree)).catch(() => {});
  globalThis.__ocmSchedulerStatus?.().then((r) => ($('#exact-hint').hidden = !pref('proactive') || r?.exact !== false)).catch(() => {});
  $('#pref-times').checked = pref('showTimes');
  $('#pref-autocontinue').checked = pref('autoContinue');
  $('#pref-tts-auto').checked = pref('ttsAuto');
  $('#pref-tts-dialogue').checked = pref('ttsDialogue');
  $('#pref-tts-actions').checked = pref('ttsSkipActions');
  $('#pref-tts-rate').value = String(pref('ttsRate'));
  $('#key-secure-note').textContent = secureStorageActive() ? ' – encrypted with the Android Keystore 🔒' : '';
  $('#pref-update-check').checked = pref('updateCheck');
  $('#gh-token').value = state.settings.ghToken || '';
  appBuild().then((b) => ($('#app-version').textContent = b ? `This is build #${b}` : 'Web version'));
  $('#pref-highlight').checked = pref('highlight');
  $('#pref-code-collapse').value = String(pref('codeCollapse'));
  $('#pref-code-wrap').checked = pref('codeWrap');
  $('#pref-memory').checked = pref('useMemory');
  $('#pref-episodes').checked = pref('episodes');
  $('#pref-tools').checked = pref('tools');
  $('#pref-tool-web').checked = pref('toolWeb');
  $('#pref-tool-python').checked = pref('toolPython');
  $('#pref-tool-phone').checked = pref('toolPhone');
  $('#pref-tool-intents').checked = pref('toolIntents');
  $('#pref-tool-device').checked = pref('toolDevice');
  $('#pref-tool-device-row').hidden = !(globalThis.__ocmDevice || globalThis.Capacitor?.isNativePlatform?.());
  $('#pref-tool-phonectl').checked = pref('toolPhoneCtl');
  $('#pref-tool-phonectl-row').hidden = !(globalThis.__ocmPhone || globalThis.Capacitor?.isNativePlatform?.());
  for (const k of ['tiles', 'overpass', 'photon']) $('#osm-' + k).value = state.settings.osm?.[k] || '';
  $('#pref-agent-mode').value = pref('agentMode');
  $('#pref-perf').checked = pref('perfTrace');
  globalThis.__ocmAutoBackup?.render();
  $('#pref-tool-phone-row').hidden = !canUsePhoneFolder();
  $('#pref-tool-intents-row').hidden = !(globalThis.__ocmIntents || globalThis.Capacitor?.isNativePlatform?.());
  $('#pref-max-steps').value = String(pref('maxSteps'));
  $('#pref-check-work').checked = pref('checkWork') !== false;
  $('#pref-shell-guard').checked = pref('shellGuard') !== false;
  $('#pref-bypass-default').checked = pref('bypassDefault') === true;
  $('#exa-key').value = state.settings.exaKey || '';
  $('#microlink-key').value = state.settings.microlinkKey || '';
  $('#pref-search').value = pref('searchProvider');
  $('#pref-zenfree').checked = pref('zenFree') === true;
  $('#pref-learn').checked = pref('learn');
  $('#pref-learn-every').value = String(pref('learnEvery'));
  $('#pref-cross-recall').checked = pref('crossRecall') === true;
  fillLearnModelSelect();
  fillPersonaSelect($('#pref-persona'), defaultChatPersona().id, (x) => !rpPersonaFlag(x));
  fillPersonaSelect($('#pref-rp-persona'), defaultRpPersona().id, rpPersonaFlag);
  $('#pref-tools-rp').checked = pref('toolsRp');
  $('#pref-rp-colors').checked = pref('rpColors');
  fillRpColors();
  rpPreview();
  $('#settings-status').textContent = '';
  const lb = pref('lastBackup');
  $('#backup-status').textContent = lb ? `Last backup: ${new Date(lb).toLocaleString()}` : 'No backup yet – your data only lives on this phone.';
  openDrawer(false);
  openSheet('#settings-sheet', true);
}
$('#open-settings').onclick = openSettings;
$('#proxy-block').hidden = !needsProxy;
$('#toggle-key').onclick = () => {
  const k = $('#api-key');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('#toggle-key').textContent = k.type === 'password' ? 'Show' : 'Hide';
};

function readSettingsForm() {
  state.settings.apiKey = $('#api-key').value.trim();
  state.settings.proxyUrl = $('#proxy-url').value.trim();
  // accept a pasted console URL like https://opencode.ai/console/<id>/activity/overview
  const ws = $('#workspace-id').value.trim();
  state.settings.workspaceId = (ws.match(/console\/([^/?#\s]+)/) || [])[1] || ws.replace(/[/?#\s].*$/, '');
  const prefsBefore = { ...(state.settings.prefs || {}) };
  const samplersBefore = state.settings.rpSamplers;
  state.settings.rpSamplers = readSamplerBox('rps');
  state.settings.ghToken = $('#gh-token').value.trim();
  {
    const v = $('#pref-compact-model').value;
    const mid = state.settings.model;
    const map = { ...(state.settings.compactAtModel || {}) };
    if (v) map[mid] = Number(v);
    else delete map[mid];
    state.settings.compactAtModel = map;
  }
  state.settings.prefs = {
    ...state.settings.prefs,
    thinking: $('#pref-thinking').value,
    textSize: $('#pref-textsize').value,
    theme: $('#pref-theme').value,
    tint: $('#pref-tint').checked,
    chatBg: $('#pref-bg').value,
    rpBg: $('#pref-bg-rp').value,
    bgDim: Number($('#pref-bg-dim').value),
    enterSends: $('#pref-enter').checked,
    autoTitle: $('#pref-autotitle').checked,
    rpPhi: $('#pref-phi').value,
    rpNote: $('#pref-rp-note').value,
    rpNoteDepth: Math.max(0, Number($('#pref-rp-note-depth').value) || 0),
    rpNoteRole: $('#pref-rp-note-role').value,
    rpPrefill: $('#pref-rp-prefill').value,
    rpImpersonate: $('#pref-rp-imp').value,
    rpNames: $('#pref-rp-names').checked,
    rpNoEmoji: $('#pref-rp-noemoji').checked,
    rpChoices: $('#pref-rp-choices').checked,
    rpTrim: $('#pref-rp-trim').checked,
    rpFixMarks: $('#pref-rp-fixmarks').checked,
    rpLore: $('#pref-rp-lore').checked,
    rpRecall: $('#pref-rp-recall').checked,
    tracker: $('#pref-tracker').checked,
    trackerFields: $('#pref-tracker-fields').value.trim(),
    rpMain: $('#pref-rp-main').value,
    ctxLimitRp: Number($('#pref-ctx-rp').value) || 0,
    ctxLimitOther: Number($('#pref-ctx-other').value) || 0,
    storyMemory: $('#pref-story').checked,
    storyEvery: Number($('#pref-story-every').value) || 16,
    storyModel: $('#pref-story-model').value,
    autoCompact: $('#pref-autocompact').checked,
    compactAt: Number($('#pref-compact-at').value) || 0.8,
    compactStyle: compactStyleOf($('#pref-compact-style').value),
    showStats: $('#pref-stats').checked,
    showGoUsage: $('#pref-go-usage').checked,
    showClaudeUsage: $('#pref-claude-usage').checked,
    notifyDone: $('#pref-notify').checked,
    autoResume: $('#pref-auto-resume').checked,
    proactive: $('#pref-proactive').checked,
    quietFrom: $('#pref-quiet-from').value || '22:00',
    quietTo: $('#pref-quiet-to').value || '08:00',
    proactiveCap: Number($('#pref-proactive-cap').value) || 3,
    showTimes: $('#pref-times').checked,
    autoContinue: $('#pref-autocontinue').checked,
    ttsAuto: $('#pref-tts-auto').checked,
    ttsDialogue: $('#pref-tts-dialogue').checked,
    ttsSkipActions: $('#pref-tts-actions').checked,
    ttsRate: Number($('#pref-tts-rate').value) || 1,
    updateCheck: $('#pref-update-check').checked,
    highlight: $('#pref-highlight').checked,
    codeCollapse: Number($('#pref-code-collapse').value) || 0,
    codeWrap: $('#pref-code-wrap').checked,
    useMemory: $('#pref-memory').checked,
    episodes: $('#pref-episodes').checked,
    toolsRp: $('#pref-tools-rp').checked,
    rpColors: $('#pref-rp-colors').checked,
    rpAction: $('#pref-rp-action').dataset.picked ? $('#pref-rp-action').value : '',
    rpQuote: $('#pref-rp-quote').dataset.picked ? $('#pref-rp-quote').value : '',
    learn: $('#pref-learn').checked,
    learnEvery: Number($('#pref-learn-every').value) || 3,
    crossRecall: $('#pref-cross-recall').checked,
    learnModel: $('#pref-learn-model').value,
    tools: $('#pref-tools').checked,
    toolWeb: $('#pref-tool-web').checked,
    toolPython: $('#pref-tool-python').checked,
    toolPhone: $('#pref-tool-phone').checked,
    toolIntents: $('#pref-tool-intents').checked,
    toolDevice: $('#pref-tool-device').checked,
    toolPhoneCtl: $('#pref-tool-phonectl').checked,
    fallbackModel: $('#pref-fallback').value,
    toolDelegate: $('#pref-delegate').checked,
    toolClaudeCode: $('#pref-claudecode').checked,
    lazyTools: $('#pref-lazy-tools').checked,
    wrapUp: $('#pref-wrapup').checked,
    leanTools: $('#pref-lean-tools').value,
    cacheHour: $('#pref-cache-hour').checked,
    toolCreate: $('#pref-create').checked,
    localModel: $('#pref-local').checked,
    toolBrowser: $('#pref-browser').checked,
    toolShell: $('#pref-shell').checked,
    toolPreview: $('#pref-preview').checked,
    helperModel: $('#pref-helper').value || 'auto',
    agentMode: $('#pref-agent-mode').value,
    perfTrace: $('#pref-perf').checked,
    maxSteps: Number($('#pref-max-steps').value) || 20,
    checkWork: $('#pref-check-work').checked,
    shellGuard: $('#pref-shell-guard').checked,
    bypassDefault: $('#pref-bypass-default').checked,
    advisorModel: $('#pref-advisor').value || '',
    searchProvider: $('#pref-search').value,
    zenFree: $('#pref-zenfree').checked,
  };
  state.settings.exaKey = $('#exa-key').value.trim();
  {
    // the map and place services: empty or the default = not stored; an address that cannot work is not taken
    const osm = {};
    for (const k of ['tiles', 'overpass', 'photon']) {
      const v = cleanOsmUrl(k, $('#osm-' + k).value);
      if (v) osm[k] = v;
      else if (v === null) $('#osm-' + k).value = state.settings.osm?.[k] || '';
    }
    if (Object.keys(osm).length) state.settings.osm = osm;
    else delete state.settings.osm;
  }
  state.settings.microlinkKey = $('#microlink-key').value.trim();
  state.settings.defaultPersonaId = $('#pref-persona').value;
  state.settings.defaultRpPersonaId = $('#pref-rp-persona').value;
  capturePreset(prefsBefore, samplersBefore); // the roleplay fields belong to the preset being edited
  saveSettings(state.settings);
  applyPrefs();
  trackSites(pref('perfTrace')); // 🩺 follows the setting at once (decision 247)
  hooks.updateModelUI?.();
  hooks.ccUsagePref?.();
}

$('#save-settings').onclick = () => {
  readSettingsForm();
  openSheet('#settings-sheet', false);
  if (!state.current.messages.length) state.current.personaId = defaultPersona().id;
  updateHeader();
  updateToolsChip();
  renderMessages();
  refreshModels();
  refreshUsage(true);
};

$('#test-conn').onclick = () => {
  readSettingsForm();
  const status = $('#settings-status');
  if (!state.settings.apiKey) return (status.textContent = 'Enter an API key first.');
  const model = state.settings.model || 'glm-5.3-flash';
  status.textContent = `Testing with ${modelName(model)}…`;
  let got = '';
  streamChat(
    state.settings,
    { model, messages: [{ role: 'user', content: 'Reply with just: ok' }], sessionId: 'test-' + uid() },
    {
      onContent: (t) => (got += t),
      onReasoning: () => {},
      onDone: () => (status.textContent = `✓ Connected. ${modelName(model)} replied: “${got.trim().slice(0, 60)}”`),
      onError: (e) => (status.textContent = '✗ ' + e.message),
    },
  );
};

// ---------- appearance (live preview while changing) ----------
function renderAccentRow() {
  const row = $('#accent-row');
  row.innerHTML = '';
  for (const c of ACCENTS) {
    const b = el('button', 'swatch' + (c ? '' : ' mono') + (pref('accent') === c ? ' active' : ''));
    if (c) b.style.background = c;
    b.setAttribute('aria-label', c ? 'Accent ' + c : 'Default accent');
    b.onclick = () => {
      setPref('accent', c);
      applyPrefs();
      renderAccentRow();
    };
    row.append(b);
  }
}
for (const [id, key, conv] of [['#pref-theme', 'theme'], ['#pref-bg', 'chatBg'], ['#pref-bg-rp', 'rpBg'], ['#pref-tint', 'tint'], ['#pref-bg-dim', 'bgDim', Number]]) {
  $(id).addEventListener(id === '#pref-bg-dim' ? 'input' : 'change', (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : conv ? conv(e.target.value) : e.target.value;
    setPref(key, v);
    applyPrefs();
      const bgKinds = [pref('chatBg'), pref('rpBg')];
    $('#bg-photo-row').hidden = !bgKinds.some((k) => ['image', 'card', 'avatar'].includes(k));
    $('#bg-photo').hidden = !bgKinds.includes('image');
    if ((key === 'chatBg' || key === 'rpBg') && v === 'image' && !state.settings.bgImage) $('#bg-photo-input').click();
    if (key === 'theme') document.querySelectorAll('.code-wrap.diagram').forEach((w) => {
      // redraw diagrams in the new theme
      w.querySelector('.mermaid-diagram')?.remove();
      w.classList.remove('diagram');
      delete w.dataset.done;
    });
    if (key === 'theme') hydrateRich(messagesEl);
  });
}
$('#pref-icons').addEventListener('change', (e) => {
  setPref('iconPack', e.target.value);
  setIconPack(e.target.value);
});
$('#bg-photo').onclick = () => $('#bg-photo-input').click();
$('#pref-notify').addEventListener('change', (e) => e.target.checked && hooks.askNotify?.());
// ⚡ Bypass permissions in new chats: turning it on asks once (the same warning as in a chat, review-ui.js); it is
// unticked until you say yes, so the auto-save never stores it on without that
$('#pref-bypass-default').addEventListener('change', async (e) => {
  const box = e.target;
  if (!box.checked) return;
  box.checked = false;
  if (!(await hooks.confirmBypass?.('new'))) return;
  box.checked = true;
  readSettingsForm();
  toast('⚡ Bypass is on for new chats');
});
$('#bg-photo-input').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const img = new Image();
  img.src = URL.createObjectURL(f);
  await img.decode().catch(() => null);
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = el('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  state.settings.bgImage = c.toDataURL('image/jpeg', 0.72);
  setPref('chatBg', 'image');
  $('#pref-bg').value = 'image';
  saveSettings(state.settings);
  applyPrefs();
  $('#bg-photo-row').hidden = false;
};

// ---------- saved tools (skills) ----------
function openSkills() {
  const list = $('#skill-list');
  list.innerHTML = '';
  const sk = state.settings.skills;
  $('#skill-count').textContent = sk.length ? `${sk.length} saved tool${sk.length === 1 ? '' : 's'}` : 'None yet. With 🛠 Tools on, ask the assistant to “save this as a tool” after it solved something you’ll need again.';
  for (const k of sk) {
    const d = el('details', 'skill-item');
    const sum = el('summary');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = k.enabled !== false;
    on.onclick = (e) => e.stopPropagation();
    on.onchange = () => {
      k.enabled = on.checked;
      saveSettings(state.settings);
    };
    sum.append(on, el('span', 'slash-cmd', 'tool_' + k.name), el('span', 'persona-desc', k.description));
    d.append(sum);
    const code = el('div', 'md');
    code.innerHTML = renderMarkdown('```python\n' + k.code + '\n```');
    const params = el('pre', 'tool-out', JSON.stringify(k.parameters || {}, null, 2));
    const del = el('button', 'danger-btn', 'Delete');
    del.onclick = () => {
      if (!confirm(`Delete tool_${k.name}?`)) return;
      state.settings.skills = state.settings.skills.filter((x) => x !== k);
      saveSettings(state.settings);
      openSkills();
    };
    d.append(el('div', 'label', 'Parameters'), params, el('div', 'label', 'Code'), code, del);
    list.append(d);
  }
  openSheet('#settings-sheet', false);
  openSheet('#skills-sheet', true);
}
$('#open-skills').onclick = openSkills;

// ---------- MCP servers ----------
/** The sign-in page in the phone's browser (Custom Tabs), which comes back to the app; a new tab on the web. */
async function openSignInPage(url) {
  if (globalThis.__ocmOpenSignIn) return globalThis.__ocmOpenSignIn(url);
  if (!Capacitor.isNativePlatform()) return void window.open(url, '_blank', 'noopener');
  const { InAppBrowser, DefaultSystemBrowserOptions } = await import('@capacitor/inappbrowser');
  await InAppBrowser.openInSystemBrowser({ url, options: DefaultSystemBrowserOptions });
}
setAuthSaver(() => saveSettings(state.settings));
function openMcp() {
  const list = $('#mcp-list');
  list.innerHTML = '';
  if (!state.settings.mcpServers.length) list.append(el('p', 'hint pad', 'No servers yet.'));
  for (const sv of state.settings.mcpServers) {
    const row = el('div', 'mcp-item');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = sv.enabled !== false;
    on.onchange = () => {
      sv.enabled = on.checked;
      saveSettings(state.settings);
      // tools are registered per session: connect now, so switching a server on takes effect at once
      if (on.checked) {
        status.textContent = 'Connecting…';
        mcpListTools(sv, { force: true })
          .then((tools) => {
            sv.toolCount = tools.length;
            saveSettings(state.settings);
            status.textContent = '✓ ' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ' ready – the assistant can use them from its next step';
          })
          .catch((e) => (status.textContent = '✗ ' + e.message));
      } else {
        status.textContent = 'Off – its tools are no longer offered';
      }
    };
    const info = el('div', 'persona-text');
    info.append(el('div', 'persona-title', sv.name), el('div', 'persona-desc', (sv.transport === 'stdio' ? '🐧 ' + sv.command : sv.url) + (sv.toolCount != null ? ` · ${sv.toolCount - (sv.disabledTools || []).length}/${sv.toolCount} tools on` : '')));
    const test = el('button', 'act', 'Test');
    const status = el('div', 'hint mcp-status');
    test.onclick = async () => {
      status.textContent = 'Connecting…';
      try {
        const tools = await mcpListTools(sv, { force: true });
        sv.toolCount = tools.length;
        saveSettings(state.settings);
        status.textContent = `✓ ${tools.length} tool${tools.length === 1 ? '' : 's'} – untick the ones the assistant should not get (fewer tools = a smaller prompt):`;
        const box = el('div', 'mcp-tools');
        // its read-only labels count only when you trust the server (MCP says to treat them as untrusted otherwise)
        const labelled = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
        if (labelled) {
          const tl = el('label', 'toggle small mcp-trust');
          const tc = el('input');
          tc.type = 'checkbox';
          tc.checked = sv.trusted === true;
          tc.onchange = () => {
            sv.trusted = tc.checked;
            saveSettings(state.settings);
          };
          tl.append(tc, el('span', null, `Trust its “read-only” labels (${labelled} tool${labelled === 1 ? '' : 's'})`), el('small', 't-hint', ' – they then work in plan mode, run side by side with other reads and are not asked about under 🛡 Ask first. Only for a server you trust: a server can label anything read-only. Never overrides “Never”.'));
          box.append(tl);
        }
        for (const t of tools) {
          const l = el('label', 'toggle small');
          const c = el('input');
          c.type = 'checkbox';
          c.checked = !(sv.disabledTools || []).includes(t.name);
          c.onchange = () => {
            const off = new Set(sv.disabledTools || []);
            c.checked ? off.delete(t.name) : off.add(t.name);
            sv.disabledTools = [...off];
            saveSettings(state.settings);
          };
          const tag = t.annotations?.destructiveHint === true && t.annotations?.readOnlyHint !== true ? ' ⚠ can delete' : t.annotations?.readOnlyHint === true ? ' · read-only' : '';
          l.append(c, el('span', null, t.name + tag), el('span', 'dim', t.description ? ' – ' + t.description.replace(/\s+/g, ' ').slice(0, 70) : ''));
          box.append(l);
        }
        status.append(box);
      } catch (e) {
        status.textContent = '✗ ' + e.message;
        if (e.needsAuth) {
          sv.needsAuth = true;
          sv.wwwAuth = e.wwwAuth || '';
          saveSettings(state.settings);
          auth.hidden = false;
          auth.textContent = 'Sign in';
        }
      }
    };
    // sign in (OAuth) – offered once a server asked for it, or when already signed in
    const auth = el('button', 'act', sv.oauth?.access ? 'Sign out' : 'Sign in');
    auth.hidden = !sv.oauth?.access && !sv.needsAuth;
    auth.onclick = async () => {
      if (sv.oauth?.access) {
        delete sv.oauth;
        saveSettings(state.settings);
        return openMcp();
      }
      status.textContent = 'Opening the sign-in page…';
      try {
        sv.oauth = await signIn(sv, { http: httpRequest, open: openSignInPage, waitRedirect, wwwAuth: sv.wwwAuth || '' });
        delete sv.needsAuth;
        saveSettings(state.settings);
        status.textContent = 'Signed in ✓ – connecting…';
        openMcp();
        [...document.querySelectorAll('#mcp-list .mcp-item')][state.settings.mcpServers.indexOf(sv)]?.querySelector('.act')?.click();
      } catch (e) {
        status.textContent = '✗ ' + e.message;
      }
    };
    const del = el('button', 'act', 'Remove');
    del.onclick = () => {
      state.settings.mcpServers = state.settings.mcpServers.filter((x) => x !== sv);
      saveSettings(state.settings);
      openMcp();
    };
    row.append(on, info, test, auth, del);
    list.append(row, status);
  }
  openSheet('#settings-sheet', false);
  openSheet('#mcp-sheet', true);
}
$('#open-mcp').onclick = openMcp;
$('#mcp-add').onclick = () => {
  const url = $('#mcp-url').value.trim();
  if (!url) return toast('Enter the server URL (https://…) or a command (npx …)');
  if (!/^https?:\/\//.test(url)) {
    // a command: a stdio server, run in the app's Linux behind mcp-bridge
    if (!canUseShell()) return toast('Commands need the built-in Linux – Settings › Linux terminal. Or enter an https:// URL.', 4500);
    const guess = url.split(/\s+/).find((w) => /[@/]|server|mcp/i.test(w) && !/^-/.test(w)) || url.split(/\s+/)[0];
    const name = $('#mcp-name').value.trim() || guess.replace(/^@[^/]+\//, '').replace(/^(mcp-)?server-|-mcp$/g, '').slice(0, 24) || 'local';
    state.settings.mcpServers.push({ id: 'mcp_' + uid().slice(0, 8), name, transport: 'stdio', command: url, bridgeSecret: uid() + uid(), enabled: true });
  } else {
    const name = $('#mcp-name').value.trim() || new URL(url).hostname.split('.').slice(-2, -1)[0] || 'server';
    state.settings.mcpServers.push({ id: 'mcp_' + uid().slice(0, 8), name, url, token: $('#mcp-token').value.trim(), headers: $('#mcp-headers').value.trim(), enabled: true });
  }
  saveSettings(state.settings);
  $('#mcp-url').value = $('#mcp-name').value = $('#mcp-token').value = $('#mcp-headers').value = '';
  openMcp();
  [...document.querySelectorAll('#mcp-list .mcp-item')].pop()?.querySelector('.act')?.click();
};

// ---------- OpenCode on your PC (opencode serve + pairing link) ----------
function openPc() {
  const list = $('#pc-list');
  list.innerHTML = '';
  for (const sv of state.settings.pcServers) {
    const row = el('div', 'mcp-item');
    const info = el('div', 'persona-text');
    info.append(el('div', 'persona-title', sv.name), el('div', 'persona-desc', sv.url + (sv.pairedAt ? ` · paired ${new Date(sv.pairedAt).toLocaleDateString()}` : '')));
    const open = el('button', 'primary-btn small', 'Open');
    open.onclick = () => openPcUrl(sv.url);
    const del = el('button', 'act', 'Remove');
    del.onclick = () => {
      state.settings.pcServers = state.settings.pcServers.filter((x) => x !== sv);
      saveSettings(state.settings);
      openPc();
    };
    row.append(info, open, del);
    list.append(row);
  }
  openDrawer(false);
  openSheet('#pc-sheet', true);
}
async function openPcUrl(url) {
  if (Capacitor.isNativePlatform()) {
    const { InAppBrowser, DefaultWebViewOptions, DefaultAndroidWebViewOptions } = await import('@capacitor/inappbrowser');
    await InAppBrowser.openInWebView({
      url,
      options: { ...DefaultWebViewOptions, showURL: false, showToolbar: true, closeButtonText: 'Close', showNavigationButtons: false, android: { ...DefaultAndroidWebViewOptions, hardwareBack: true, pauseMedia: true } },
    });
  } else window.open(url, '_blank');
}
$('#open-pc').onclick = openPc;
$('#pc-connect').onclick = async () => {
  const link = $('#pc-link').value.trim();
  let u;
  try {
    u = new URL(link);
  } catch {
    return toast('Paste the link printed by `opencode pair`');
  }
  const base = u.origin;
  const existing = state.settings.pcServers.find((x) => x.url === base);
  const name = $('#pc-name').value.trim() || existing?.name || (u.hostname.includes('.') && !/^\d/.test(u.hostname) ? u.hostname : `PC (${u.hostname})`);
  if (existing) Object.assign(existing, { name, pairedAt: Date.now() });
  else state.settings.pcServers.push({ id: 'pc_' + uid().slice(0, 8), name, url: base, pairedAt: Date.now() });
  saveSettings(state.settings);
  $('#pc-link').value = '';
  openPc();
  // the one-time /auth/connect/<token> link sets a 30-day session cookie, then shows OpenCode's web UI
  await openPcUrl(/\/auth\/connect\//.test(u.pathname) ? link : base);
};

// ---------- custom endpoints (OpenAI-compatible, e.g. Chub Soji) ----------
let provDraft = null;
function openProviders() {
  const list = $('#prov-list');
  list.innerHTML = '';
  if (!state.settings.providers.length) list.append(el('p', 'hint pad', 'None yet. Add Chub (Soji), Anthropic (Claude) or any OpenAI-compatible endpoint.'));
  for (const p of state.settings.providers) {
    const row = el('div', 'mcp-item');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = p.enabled !== false;
    on.onchange = () => {
      p.enabled = on.checked;
      saveSettings(state.settings);
      refreshModels(true);
    };
    const info = el('div', 'persona-text');
    const desc = el('div', 'persona-desc', p.baseUrl + (p.lastModels != null ? ` · ${p.lastModels} models` : ''));
    info.append(el('div', 'persona-title', p.name), desc);
    // what is left on it, where the endpoint says (DeepSeek, decision 195) – read each time this list opens
    if (hasBalance(p) && p.enabled !== false) {
      const bal = el('div', 'persona-desc prov-balance', 'Balance…');
      info.append(bal);
      providerBalance(p)
        .then((b) => (bal.textContent = b ? `Balance: ${b.text}${b.available ? '' : ' – not enough to use it'}` : ''))
        .catch((e) => (bal.textContent = `Balance: could not read it (${String(e?.message || e).slice(0, 80)})`));
    }
    // a Claude endpoint with an Admin key: what it has spent (decision 208)
    if (hasSpend(p) && p.enabled !== false) {
      const sp = el('div', 'persona-desc prov-spend', 'Spent…');
      info.append(sp);
      const usd = (v) => '$' + (v < 10 ? v.toFixed(2) : v.toFixed(0));
      providerSpend(p)
        .then((r) => {
          if (!r) return (sp.textContent = '');
          const top = r.models.filter(([, v]) => v >= 0.005).slice(0, 3).map(([m, v]) => `${m.replace(/^claude-/, '')} ${usd(v)}`).join(' · ');
          const when = r.refreshed ? ` · figures up to ${new Date(r.refreshed).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
          sp.textContent = `Spent: today ${usd(r.today)} · 7 days ${usd(r.week)} · ${r.monthName} ${usd(r.month)}${when} (before credits)`;
          if (top) info.append(el('div', 'persona-desc prov-spend-models', `This month: ${top}`));
        })
        .catch((e) => (sp.textContent = `Spent: could not read it (${String(e?.message || e).slice(0, 120)})`));
    }
    const edit = el('button', 'act', 'Edit');
    edit.onclick = () => editProvider(p);
    row.append(on, info, edit);
    list.append(row);
  }
  $('#prov-main').hidden = false;
  $('#prov-edit').hidden = true;
  openSheet('#settings-sheet', false);
  openSheet('#prov-sheet', true);
}
function editProvider(p, preset) {
  const base = preset ? PROVIDER_PRESETS[preset] : {};
  provDraft = p ? { ...p } : { id: 'pv' + uid().slice(0, 6), enabled: true, apiKey: '', ...base };
  $('#pv-name').value = provDraft.name || '';
  $('#pv-url').value = provDraft.baseUrl || '';
  $('#pv-key').value = provDraft.apiKey || '';
  $('#pv-admin').value = provDraft.adminKey || '';
  $('#pv-auth').value = provDraft.auth || 'bearer';
  $('#pv-via').value = provDraft.via || 'native';
  $('#pv-models').value = provDraft.models || '';
  $('#pv-context').value = provDraft.context || 32768;
  $('#pv-maxtok').value = provDraft.maxTokens || '';
  $('#pv-tools').checked = provDraft.tools !== false;
  $('#pv-vision').checked = !!provDraft.vision;
  $('#pv-status').textContent = '';
  $('#pv-delete').hidden = !p;
  // Anthropic: key and base URL; each model's context, tools and images come from the live model list
  const claude = provDraft.kind === 'anthropic';
  $('#pv-anthropic-note').hidden = !claude;
  $('#pv-admin-row').hidden = !claude;
  $('#pv-url-hint').hidden = claude; // "(ends in /v1)" is for OpenAI-compatible endpoints
  $('#pv-oai').hidden = claude;
  $('#pv-oai-caps').hidden = claude;
  $('#pv-context-row').hidden = claude;
  $('#pv-url').placeholder = claude ? 'https://api.anthropic.com' : 'https://inference.chub.ai/soji/v1';
  $('#prov-main').hidden = true;
  $('#prov-edit').hidden = false;
}
function readProviderForm() {
  return {
    ...provDraft,
    name: $('#pv-name').value.trim() || 'Custom endpoint',
    baseUrl: $('#pv-url').value.trim(),
    apiKey: $('#pv-key').value.trim(),
    ...(provDraft.kind === 'anthropic' ? { adminKey: $('#pv-admin').value.trim() || undefined } : {}),
    auth: $('#pv-auth').value,
    via: $('#pv-via').value,
    models: $('#pv-models').value.trim(),
    context: Number($('#pv-context').value) || 32768,
    maxTokens: Number($('#pv-maxtok').value) || undefined,
    tools: $('#pv-tools').checked,
    vision: $('#pv-vision').checked,
  };
}
$('#prov-add-chub').onclick = () => editProvider(null, 'chub');
$('#prov-add-custom').onclick = () => editProvider(null, 'openai');
$('#prov-add-anthropic').onclick = () => editProvider(null, 'anthropic');
$('#pv-back').onclick = openProviders;
$('#pv-test').onclick = async () => {
  const p = readProviderForm();
  if (!/^https?:\/\/./.test(p.baseUrl)) return ($('#pv-status').textContent = 'Enter the base URL (…/v1)');
  if (p.kind === 'anthropic' && !p.apiKey) return ($('#pv-status').textContent = 'Enter your Anthropic API key (platform.claude.com › API keys)');
  $('#pv-status').textContent = 'Checking…';
  const r = await listProviderModels(p);
  const names = r.models.map((m) => m.apiModel);
  const listLine = r.error
    ? `Model list: unavailable (${r.error.slice(0, 160)}).${names.length ? ' Using: ' + names.join(', ') : ' Type the model name(s) above.'}`
    : `Model list: ✓ ${names.length} – ${names.slice(0, 30).join(', ')}`;
  $('#pv-status').textContent = listLine + (names.length ? `\nChat test with “${names[0]}”: sending…` : '');
  if (!names.length) return;
  // a real tiny chat request – the part that matters
  setModelRoutes([...state.models.filter((m) => m.providerId !== p.id), ...r.models], [...state.settings.providers.filter((x) => x.id !== p.id), p]);
  let reply = '';
  const res = await new Promise((resolve) => {
    streamChat(state.settings, { model: r.models[0].id, sessionId: 'test-' + uid(), messages: [{ role: 'user', content: 'Reply with just: ok' }] }, {
      onContent: (t) => (reply += t),
      onReasoning: () => {},
      onDone: () => resolve('✓ replied: “' + reply.trim().slice(0, 80) + '”'),
      onError: (e) => resolve('✗ ' + e.message.slice(0, 300)),
    });
  });
  $('#pv-status').textContent = listLine + `\nChat test with “${names[0]}”: ${res}`;
  setModelRoutes(state.models, state.settings.providers);
};
$('#pv-save').onclick = async () => {
  const p = readProviderForm();
  if (!/^https?:\/\/./.test(p.baseUrl)) return toast('Enter the base URL');
  const i = state.settings.providers.findIndex((x) => x.id === p.id);
  if (i >= 0) state.settings.providers[i] = p;
  else state.settings.providers.push(p);
  saveSettings(state.settings);
  const r = await listProviderModels(p);
  p.lastModels = r.models.length;
  // the first Claude provider, nothing usable picked yet: start on Claude Opus 5.5 (else the newest model listed)
  if (p.kind === 'anthropic' && r.models.length && !state.models.some((m) => m.id === state.settings.model)) state.settings.model = (r.models.find((m) => m.apiModel === 'claude-opus-5-5') || r.models[0]).id;
  saveSettings(state.settings);
  toast(r.models.length ? `${p.name}: ${r.models.length} model${r.models.length === 1 ? '' : 's'} added to the model picker` : `${p.name} saved – add a model name so it shows up`, 3500);
  openProviders();
  refreshModels(true);
};
$('#pv-delete').onclick = () => {
  if (!confirm(`Remove ${provDraft.name}?`)) return;
  state.settings.providers = state.settings.providers.filter((x) => x.id !== provDraft.id);
  saveSettings(state.settings);
  openProviders();
  refreshModels(true);
};
$('#open-providers').onclick = openProviders;

// ---------- usage history ----------
function openUsageHistory() {
  const u = usageSummary(state.models, 30);
  const dollars = (v) => (v >= 10 ? '$' + v.toFixed(0) : v >= 0.1 ? '$' + v.toFixed(2) : v > 0 ? '$' + v.toFixed(3) : '$0');
  // a model with no known price is not $0: "price unknown", or "$1.20 + ?" when only part of it is priced (decision 275)
  const money = (v, unpriced = false) => (unpriced ? (v > 0 ? dollars(v) + ' + ?' : 'price unknown') : dollars(v));
  const tiles = $('#uh-tiles');
  tiles.innerHTML = '';
  for (const [label, t] of [['Today', u.totals.today], ['7 days', u.totals.week], ['30 days', u.totals.month]]) {
    const d = el('div', 'uh-tile');
    d.append(el('div', 'uh-label', label), el('div', 'uh-big', fmtTokens(t.in + t.out)), el('div', 'uh-sub', `${t.reqs} requests · ${money(t.value, t.unpriced)}`));
    tiles.append(d);
  }
  const chart = $('#uh-chart');
  chart.innerHTML = '';
  const last = u.days.slice(-14);
  const max = Math.max(1, ...last.map((d) => d.in + d.out));
  for (const d of last) {
    const col = el('div', 'uh-col');
    col.title = `${d.day}: ${fmtTokens(d.in)} in, ${fmtTokens(d.out)} out, ${d.reqs} requests`;
    const bar = el('div', 'uh-bar');
    const a = el('i', 'in');
    a.style.height = (d.in / max) * 100 + '%';
    const b2 = el('i', 'out');
    b2.style.height = (d.out / max) * 100 + '%';
    bar.append(b2, a);
    col.append(bar, el('span', 'uh-day', String(+d.day.slice(-2))));
    chart.append(col);
  }
  const srcBox = $('#uh-sources');
  srcBox.innerHTML = '';
  const srcs = sourceSpend(state.models).slice(0, 12);
  if (!srcs.length) srcBox.append(el('p', 'hint pad', 'Counting starts from now.'));
  const srcMax = Math.max(1, ...srcs.map((r) => r.in + r.out));
  for (const r of srcs) {
    const row = el('div', 'uh-row uh-src');
    row.style.setProperty('--share', ((r.in + r.out) / srcMax) * 100 + '%');
    row.append(el('span', 'uh-model', r.name), el('span', 'uh-num', fmtTokens(r.in + r.out)), el('span', 'uh-num', `${r.reqs}×`), el('span', 'uh-num', money(r.value, r.unpriced)));
    srcBox.append(row);
  }
  const chats = $('#uh-chats');
  chats.innerHTML = '';
  const spend = chatSpend(state.models).filter((r) => state.convs.some((c) => c.id === r.id)).slice(0, 8);
  if (!spend.length) chats.append(el('p', 'hint pad', 'Per-chat numbers start counting from now.'));
  for (const r of spend) {
    const row = el('button', 'uh-row');
    row.append(el('span', 'uh-model', state.convs.find((c) => c.id === r.id)?.title || 'Chat'), el('span', 'uh-num', fmtTokens(r.in + r.out)), el('span', 'uh-num', `${r.reqs}×`), el('span', 'uh-num', money(r.value, r.unpriced)));
    row.onclick = () => {
      openSheet('#usage-sheet', false);
      selectConv(r.id);
    };
    chats.append(row);
  }
  const bud = $('#uh-budget');
  bud.value = pref('dailyBudgetM') || 0;
  bud.onchange = () => {
    (state.settings.prefs ||= {}).dailyBudgetM = Math.max(0, Number(bud.value) || 0);
    saveSettings(state.settings);
    $('#uh-budget-note').textContent = state.settings.prefs.dailyBudgetM ? `Warns when today passes ${state.settings.prefs.dailyBudgetM}M` : 'No limit';
  };
  $('#uh-budget-note').textContent = pref('dailyBudgetM') ? `Today so far: ${fmtTokens(todayTokens())}` : 'No limit';
  const tbl = $('#uh-models');
  tbl.innerHTML = '';
  if (!u.models.length) tbl.append(el('p', 'hint pad', 'No usage recorded yet.'));
  for (const m of u.models) {
    const row = el('div', 'uh-row');
    row.append(el('span', 'uh-model', modelName(m.model)), el('span', 'uh-num', `${fmtTokens(m.in)} in${m.cached ? ` (${fmtTokens(m.cached)} cached)` : ''}`), el('span', 'uh-num', `${fmtTokens(m.out)} out`), el('span', 'uh-num', `${m.reqs}×`), el('span', 'uh-num', money(m.value, m.unpriced)));
    tbl.append(row);
  }
  openDrawer(false);
  openSheet('#settings-sheet', false);
  openSheet('#usage-sheet', true);
}
$('#open-usage').onclick = openUsageHistory;
$('#uh-clear').onclick = () => {
  if (!confirm('Clear the usage history on this phone?')) return;
  clearUsage();
  openUsageHistory();
};

$('#rp-main-default').onclick = () => {
  $('#pref-rp-main').value = DEFAULT_MAIN + '\n' + RP_GUIDE;
};

// roleplay colours: live preview
// A colour is kept only once you pick one; until then the theme's own default shows (light and dark differ).
const RP_COLOR_INPUTS = [
  ['#pref-rp-action', 'rpAction', '--rp-action'],
  ['#pref-rp-quote', 'rpQuote', '--rp-quote'],
];
const themeRpColor = (cssVar) => getComputedStyle(document.documentElement).getPropertyValue(cssVar + '-def').trim();
function fillRpColors(reset = false) {
  for (const [id, k, v] of RP_COLOR_INPUTS) {
    const picked = reset ? '' : rpColor(k);
    $(id).value = picked || themeRpColor(v) || '#888888';
    $(id).dataset.picked = picked ? '1' : '';
  }
}
function rpPreview() {
  for (const [id, , v] of RP_COLOR_INPUTS) {
    if ($(id).dataset.picked) document.documentElement.style.setProperty(v, $(id).value);
    else document.documentElement.style.removeProperty(v);
  }
  $('#rp-color-preview').innerHTML = mdRender('*She leans against the doorframe.* "You\'re late," she says, *smirking.*', { rp: true });
  $('#rp-color-preview').classList.toggle('rp-on', $('#pref-rp-colors').checked);
}
['#pref-rp-action', '#pref-rp-quote'].forEach((id) =>
  $(id).addEventListener('input', () => {
    $(id).dataset.picked = '1';
    rpPreview();
  }),
);
$('#pref-rp-colors').addEventListener('input', rpPreview);
$('#pref-rp-colors').addEventListener('change', rpPreview);
$('#rp-colors-reset').onclick = () => {
  fillRpColors(true);
  rpPreview();
  hooks.flushSettings?.();
};

// ---------- backup & restore ----------
$('#backup-export').onclick = async () => {
  const btn = $('#backup-export');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    readSettingsForm();
    const d = new Date();
    const name = `chronicle-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
    const { size, stats } = await shareStream(name, (sink) => streamBackup(state.settings, { includeKeys: $('#backup-keys').checked, onProgress: (t) => ($('#backup-status').textContent = '⏳ ' + t) }, sink));
    setPref('lastBackup', Date.now());
    $('#backup-status').textContent = `Backed up ${stats.chats} chats, ${stats.personas} personas, ${stats.memories} memories, ${stats.files} files (${fmtBytes(size)}). Save it to Drive or Files from the share menu.`;
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) $('#backup-status').textContent = '✗ ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = '⤴ Export backup';
};
// ---------- move everything (decision 218) ----------
const day = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const moveSay = (t) => ($('#move-status').textContent = t);
/** Run a background tar in Linux and wait for it, saying how far it is. → { ok, bytes, log } */
async function homeTar(cmd, what) {
  await runShell(cmd, { id: 'move', timeoutMs: 30000 });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = parseHomeStatus((await runShell(homeStatusCmd(), { id: 'move', timeoutMs: 30000 }))?.output);
    if (s.done) return s;
    moveSay(`⏳ ${what}… ${s.bytes ? fmtBytes(s.bytes) : ''}`);
  }
}
const linuxReady = async () => canUseShell() && !!(await shellStatus().catch(() => null))?.installed;
$('#move-export').onclick = async () => {
  if (!confirm('Export everything, including your API keys and sign-ins?\n\nAnyone with these files can use your keys and accounts. Keep them private, move them to the new app, then delete them.')) return;
  const btn = $('#move-export');
  btn.disabled = true;
  try {
    readSettingsForm();
    const { size, stats } = await shareStream(`chronicle-everything-${day()}.zip`, (sink) => streamBackup(state.settings, { everything: true, onProgress: (t) => moveSay('⏳ ' + t) }, sink));
    let linux = '';
    if ((await linuxReady()) && canExportLinux()) {
      const s = await homeTar(packHomeCmd(), 'Packing the Linux home folder');
      if (!s.ok) throw new Error('the app data zip was saved, but packing Linux /root failed' + (s.log ? ': ' + s.log : '') + ' – try Export everything again (the zip is made again too)');
      moveSay('⏳ Saving the Linux home folder…');
      const r = await exportLinuxFile(HOME_TAR, { name: `chronicle-linux-home-${day()}.tar.gz` }, (done, total) => moveSay(`⏳ Saving the Linux home folder… ${fmtBytes(done)} of ${fmtBytes(total)}`));
      await runShell(cleanHomeCmd(), { id: 'move', timeoutMs: 30000 }).catch(() => {});
      linux = ` Linux home folder: ${r.name} (${fmtBytes(r.bytes)}) in ${r.folder}.${s.skipped ? ` ${s.skipped} file${s.skipped === 1 ? '' : 's'} could not be read and ${s.skipped === 1 ? 'was' : 'were'} left out${s.skippedNames.length ? ` (${s.skippedNames.slice(0, 3).join(', ')}${s.skipped > 3 ? '…' : ''})` : ''}.` : ''}`;
    }
    moveSay(`✓ Everything exported: ${stats.chats} chats, ${stats.files} files, ${stats.extras} git histories and indexes, with keys (${fmtBytes(size)}).${linux || ' (No Linux home: Linux is not set up here.)'} Keep these files private.`);
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) moveSay('✗ ' + e.message);
  }
  btn.disabled = false;
};
$('#move-linux-import').onclick = async () => {
  if (!(await linuxReady())) return moveSay('✗ Set up Linux first (Settings › Linux terminal), then import its home folder.');
  if (!confirm('Unpack a Linux home archive (chronicle-linux-home-….tar.gz) into /root? Files of the same name there are replaced.')) return;
  const btn = $('#move-linux-import');
  btn.disabled = true;
  try {
    const file = `${MOVE_DIR}/import.tar.gz`;
    moveSay('Pick the chronicle-linux-home file…');
    const r = await pickIntoLinux(file, (done, total) => moveSay(`⏳ Copying into Linux… ${fmtBytes(done)}${total > 0 ? ` of ${fmtBytes(total)}` : ''}`));
    if (!r?.bytes) {
      moveSay('');
      return;
    }
    const s = await homeTar(unpackHomeCmd(file), 'Unpacking into /root');
    if (!s.ok) throw new Error('unpacking failed (is it a .tar.gz from Export everything?)' + (s.log ? ': ' + s.log : ''));
    moveSay(`✓ Linux home folder restored (${fmtBytes(r.bytes)}). Set up Claude Code again in Settings › Account & models if you use it, and sign in there.`);
  } catch (e) {
    moveSay('✗ ' + e.message);
  }
  btn.disabled = false;
};
let pendingRestore = null;
// On the phone the picked file is copied into the app's storage and read from there in exact pieces (decision 220)
$('#backup-import').onclick = async () => {
  if (!canPickToCache()) return $('#backup-file').click();
  try {
    const f = await pickFileToCache((done, total) => toast(`Reading the backup… ${fmtBytes(done)}${total > 0 ? ` of ${fmtBytes(total)}` : ''}`));
    if (f) await openRestore(f);
  } catch (err) {
    toast(err.message, 9000);
  }
};
$('#backup-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await openRestore(f);
};
async function openRestore(f) {
  try {
    toast('Reading the backup…');
    pendingRestore = await readBackupFile(f); // a piece at a time (a big backup does not fit in memory at once)
    pendingRestore.drop = f.drop; // the copy in the app's storage goes once it is restored
    const d = pendingRestore.data;
    $('#restore-info').textContent = RESTORE_INFO(d);
    openSheet('#settings-sheet', false);
    openSheet('#restore-sheet', true);
  } catch (err) {
    toast(err.message, 9000);
  }
}
const RESTORE_INFO = (d) => `Backup from ${new Date(d.exportedAt).toLocaleString()}: ${d.conversations?.length || 0} chats, ${d.settings?.personas?.length || 0} personas, ${d.settings?.memories?.length || 0} memories, files for ${pendingRestore.wsCount ?? Object.keys(pendingRestore.ws).length} chats.${d.everything ? ' This is an Export everything (with keys, git histories and indexes): on a new app choose Replace.' : d.settings?.apiKey ? ' Includes API key.' : ''}`;
async function doRestore(mode) {
  if (!pendingRestore) return;
  if (mode === 'replace' && !confirm('Replace everything on this phone with the backup? Current chats and settings will be deleted.')) return;
  try {
    stopStream();
    sandbox.kill();
    const { settings, stats } = await applyBackup(pendingRestore, mode, state.settings);
    ensurePersonas(settings);
    await saveSettings(settings);
    // files damaged in the zip were left out: say which, before the app reloads
    if (stats.damaged?.length) alert(`Restored, but ${stats.damaged.length} file${stats.damaged.length === 1 ? ' was' : 's were'} damaged in the backup and left out:\n\n${stats.damaged.slice(0, 8).join('\n')}${stats.damaged.length > 8 ? '\n…' : ''}`);
    pendingRestore.drop?.();
    toast('Restored – reloading…');
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    toast('Restore failed: ' + e.message, 5000);
  }
}
$('#restore-merge').onclick = () => doRestore('merge');
$('#restore-replace').onclick = () => doRestore('replace');

$('#clear-all').onclick = async () => {
  if (!confirm('Delete all chats? This cannot be undone.')) return;
  // a reply still running (in any chat, on screen or not) would save its chat back when it ends
  for (const id of new Set([...state.convs.map((c) => c.id), ...state.runs.keys(), state.current?.id].filter(Boolean))) markDeleted(id);
  await conversations.clear();
  state.settings.memories = state.settings.memories.filter((m) => !m.conv); // roleplay memories go with their chats
  saveSettings(state.settings);
  for (const id of await workspaces.ids().catch(() => [])) await deleteWorkspace(id); // with the shell's copy of each
  await workspaces.clear().catch(() => {});
  sandbox.kill();
  state.convs = [];
  newChat();
  openSheet('#settings-sheet', false);
};

export { openSettings, openUsageHistory, setPage, showSettingsPage };

// ---------- storage: what's using space, and cleanup ----------
/**
 * About how many bytes a saved object takes, without turning it into text: its strings, numbers and binary data, walked
 * (decision 258 – the text of every chat at once froze the page for seconds with a lot saved).
 */
export function approxSize(o, seen = new Set()) {
  if (o == null) return 0;
  const t = typeof o;
  if (t === 'string') return o.length;
  if (t === 'number' || t === 'boolean') return 8;
  if (t !== 'object' || seen.has(o)) return 0;
  if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) return o.byteLength;
  seen.add(o);
  let n = 0;
  if (Array.isArray(o)) for (const v of o) n += approxSize(v, seen) + 1;
  else for (const k in o) n += k.length + 4 + approxSize(o[k], seen);
  return n;
}
const breath = () => new Promise((r) => setTimeout(r, 0));
async function renderStorage() {
  const box = $('#storage-view');
  box.hidden = false;
  box.innerHTML = '';
  box.append(el('p', 'hint', 'Measuring…'));
  // the chats as the app has them, sized a few at a time so the page stays responsive; the files from the workspace index
  // (count and size per chat) – not every chat and every file read from the database at once (decision 258)
  await hooks.loadAllMessages?.(); // the chats whose messages are not loaded yet (decision 260)
  const [wss, arts, est] = await Promise.all([workspaceSummaries().catch(() => []), art.all().catch(() => ({})), navigator.storage?.estimate?.().catch(() => null)]);
  const convs = [...state.convs];
  const chats = [];
  for (let i = 0; i < convs.length; i++) {
    chats.push({ c: convs[i], bytes: approxSize(convs[i]) });
    if (i % 10 === 9) await breath();
  }
  if (!box.isConnected || box.hidden) return;
  chats.sort((a, b) => b.bytes - a.bytes);
  const byId = new Map(convs.map((c) => [c.id, c]));
  const files = wss
    .map((w) => ({ id: w.id, c: byId.get(w.id), count: w.n || 0, bytes: w.size || 0 }))
    .filter((x) => x.count)
    .sort((a, b) => b.bytes - a.bytes);
  const arts2 = Object.entries(arts)
    .filter(([, url]) => url)
    .map(([id, url]) => ({ id, p: state.settings.personas.find((p) => p.id === id), bytes: Math.round(url.length * 0.75) }))
    .sort((a, b) => b.bytes - a.bytes);
  const sum = (l) => l.reduce((n, x) => n + x.bytes, 0);
  const settingsBytes = approxSize(state.settings);
  box.innerHTML = '';
  const total = sum(chats) + sum(files) + sum(arts2) + settingsBytes;
  box.append(el('p', 'hint', `About ${fmtBytes(total)} in total${est?.usage ? ` (the phone reports ${fmtBytes(est.usage)} used by the app's storage)` : ''}.`));

  const section = (title, list, size, row, empty) => {
    const d = el('details', 'storage-group');
    d.append(el('summary', null, `${title} · ${fmtBytes(size)}`));
    if (!list.length) d.append(el('p', 'hint', empty));
    list.slice(0, 12).forEach((x) => d.append(row(x)));
    if (list.length > 12) d.append(el('p', 'hint', `…and ${list.length - 12} more`));
    box.append(d);
    return d;
  };
  const line = (label, bytes, ...btns) => {
    const r = el('div', 'storage-row');
    r.append(el('span', 'storage-name', label), el('span', 'storage-size', fmtBytes(bytes)), ...btns);
    return r;
  };
  const btn = (text, fn, danger) => {
    const b = el('button', danger ? 'act danger-text' : 'act', text);
    b.onclick = fn;
    return b;
  };
  section(`💬 Chats (${chats.length})`, chats, sum(chats), (x) =>
    line(x.c.title || 'Untitled chat', x.bytes, btn('Open', () => {
      openSheet('#settings-sheet', false);
      selectConv(x.c.id);
    })), 'No saved chats.');
  section(`📁 Chat files (${files.length} chats)`, files, sum(files), (x) =>
    line(`${x.c ? x.c.title || 'Untitled chat' : '(deleted chat)'} – ${x.count} file${x.count === 1 ? '' : 's'}`, x.bytes, btn('Delete files', async () => {
      if (!confirm(`Delete the ${x.count} file(s) of “${x.c?.title || 'a deleted chat'}”? The chat itself stays.`)) return;
      await deleteWorkspace(x.id);
      toast('Files deleted');
      renderStorage();
    }, true)), 'No files in any chat.');
  section(`🖼 Full-size character art (${arts2.length})`, arts2, sum(arts2), (x) =>
    line(x.p ? x.p.name : '(deleted character)', x.bytes, btn(x.p ? 'Remove art' : 'Delete', async () => {
      if (x.p && !confirm(`Remove ${x.p.name}'s full-size art? The small avatar stays.`)) return;
      await art.remove(x.id);
      if (x.p) {
        delete x.p.hasArt;
        saveSettings(state.settings);
      }
      toast(x.p ? 'Full art removed' : 'Deleted');
      renderStorage();
    }, true)), 'No full-size art saved.');
  const mem = state.settings.memories?.length || 0;
  box.append(line(`⚙ Settings, personas, ${mem} memories, lorebooks`, settingsBytes));
}
$('#storage-show').onclick = renderStorage;

$('#pref-proactive').addEventListener('change', (e) => ($('#proactive-opts').hidden = !e.target.checked));
$('#exact-allow').onclick = () => globalThis.__ocmSchedulerAskExact?.();
$('#osm-reset').onclick = () => {
  for (const k of ['tiles', 'overpass', 'photon']) $('#osm-' + k).value = '';
  $('#osm-tiles').dispatchEvent(new Event('change', { bubbles: true }));
};
$('#osm-clear-tiles').onclick = () =>
  Promise.resolve(hooks.clearMapTiles?.())
    .then(() => toast('Saved map tiles cleared'))
    .catch((e) => toast(String(e?.message || e)));
$('#battery-allow').onclick = () => hooks.device?.askBattery?.().then(() => toast('Choose Allow, then come back')).catch((e) => toast(String(e?.message || e)));

// limits learned from "too long for this model" errors (engine.js): seen here, and forgotten when one was wrong
function renderLearned() {
  const l = Object.entries(state.settings.learnedLimits || {});
  $('#learned-box').hidden = !l.length;
  $('#learned-sum').textContent = l.length ? `Context limits learned from the providers' errors: ${l.map(([m, n]) => `${m.split(':').pop()} ${Math.round(n / 1000)}K`).join(', ')}` : '';
}
$('#learned-forget').onclick = () => {
  delete state.settings.learnedLimits;
  saveSettings(state.settings);
  renderLearned();
  toast('Forgotten – the model lists decide again');
};
