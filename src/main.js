import { watchIcons, setIconPack } from './icons.js';
import { saveSettings } from './store.js';
import { GLOBAL } from './memory.js';
import './app/core.js';
import { flushLog, logError } from './errorlog.js';
// a crash in the app's own code is logged even when nothing on screen shows it (decision 177)
window.addEventListener('error', (e) => {
  if (e.target && e.target !== window) return; // a picture or script that did not load is not a crash
  logError('app', e.message || 'error', { where: e.filename ? `${String(e.filename).split('/').pop()}:${e.lineno}:${e.colno}` : String(e.error?.stack || '').split('\n')[1]?.trim() || '' });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  logError('app', 'Unhandled: ' + (r?.message || r || 'rejected promise'), { where: String(r?.stack || '').split('\n')[1]?.trim() || '' });
});
document.addEventListener('visibilitychange', () => document.hidden && flushLog());

import './app/choose.js';
import './app/chatlist.js';
import './app/render.js';
import './app/engine.js';
import './app/voicemode.js';
import './app/recipes-ui.js';
import './app/errlog-ui.js';
import './app/git-ui.js';
import './app/packs-ui.js';
import './app/automation.js';
import './app/pty-ui.js';
import './app/acp-ui.js';
import './app/claudecode-ui.js';
import './app/voice-settings.js';
import './app/jobs-ui.js';
import './app/github-ui.js';
import './app/rppresets-ui.js';
import './app/composer.js';
import './app/settings.js';
import './app/settings-search.js';
import './app/personas-ui.js';
import './app/extras.js';
import './app/wsmanager.js';
import './app/skills-ui.js';
import './app/share-ui.js';
import './app/plan-ui.js';
import './app/autobackup.js';
import './app/mods-ui.js';
import './app/review-ui.js';
import './app/storymap-ui.js';
import './app/prompttest-ui.js';
import './app/terminal-ui.js';
import './app/rules-ui.js';
import './app/select-ui.js';
import './app/charview.js';
import './app/map-ui.js';
import './app/private-ui.js';
import './app/btw.js';
import './app/info.js';
import { loadConvs, newChat, refreshUsage, setMode } from './app/chatlist.js';
import { refreshModels, updateModelUI } from './app/composer.js';
import { appMode, chatPersona, hooks, pref, setAppMode, state } from './app/core.js';
import { updateShortcuts, updateToolsChip } from './app/extras.js';
import { updateHeader } from './app/render.js';
import { openSettings } from './app/settings.js';

// ---------- boot ----------
(async () => {
  setAppMode(pref('mode') === 'rp' ? 'rp' : 'chat');
  await loadConvs();
  setMode(appMode, { fresh: false });
  updateShortcuts();
  // older memories had no scope: ones you added become global, learned ones go to the persona of their chat
  let migrated = false;
  for (const m of state.settings.memories) {
    if (m.scope) continue;
    const conv = m.source !== 'manual' && state.convs.find((c) => c.id === m.source);
    m.scope = conv ? chatPersona(conv).id : GLOBAL;
    migrated = true;
  }
  // decision 199: agent chats compact "Structured + short summary" by default (roleplays keep the model summary) –
  // once, for a setting that was still on the old default
  const pr = (state.settings.prefs ||= {});
  if (!pr.compactStyleV) {
    if (!pr.compactStyle || pr.compactStyle === 'summary') pr.compactStyle = 'both';
    pr.compactStyleV = 1;
    migrated = true;
  }
  if (migrated) saveSettings(state.settings);
  newChat();
  updateHeader();
  updateToolsChip();
  updateModelUI();
  refreshModels(true);
  refreshUsage(true);
  if (!state.settings.apiKey) setTimeout(openSettings, 300);
  hooks.restoreDraft?.();
  hooks.renderQuickBar?.();
  watchIcons(); // icons in place of the interface's emoji (line icons first; another pack redraws them)
  if (pref('iconPack') !== 'line') setIconPack(pref('iconPack'));
  document.body.dataset.ready = '1'; // the app is up and listening (the page shell is visible earlier)
})();
