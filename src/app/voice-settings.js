// Settings › 🔊 Voice › Better voices: the default engine and voice (used by every persona without its own).
import { $, hooks, pref, toast } from './core.js';
import { canSpeak, installVoices, listVoices, speak } from '../speech.js';
import { setPref } from './extras.js';

const label = (v) => `${v.name}${v.lang ? ` · ${v.lang}` : ''}${v.network ? ' · online' : ''}`;
async function fill(engine, selected) {
  const sel = $('#vs-voice');
  const status = $('#vs-status');
  sel.innerHTML = '';
  sel.append(new Option('The engine’s default voice', ''));
  status.textContent = 'Loading voices…';
  try {
    const r = await listVoices(engine || null);
    const eng = $('#vs-engine');
    if (!eng.options.length) {
      eng.append(new Option(`Phone default${r.defaultEngine ? ` (${(r.engines.find((e) => e.name === r.defaultEngine) || {}).label || r.defaultEngine})` : ''}`, ''));
      for (const e of r.engines) if (e.name !== 'browser') eng.append(new Option(e.label || e.name, e.name));
      eng.value = engine || '';
    }
    const vs = [...r.voices].sort((a, b) => a.network - b.network || String(a.lang).localeCompare(b.lang) || a.name.localeCompare(b.name));
    for (const v of vs) sel.append(new Option(label(v), v.name));
    sel.value = vs.some((v) => v.name === selected) ? selected : '';
    const others = r.engines.filter((e) => e.name !== 'browser').length;
    status.textContent = `${vs.length ? `${vs.length} voices` : 'This engine reports no separate voices – it uses its own'}${others <= 1 ? ' · only one engine is installed – “Get voices / engines” opens the store' : ` · ${others} engines installed`}`;
  } catch (e) {
    status.textContent = e.message || 'Could not load voices';
  }
}
/** Called when the Voice page opens. */
hooks.openVoiceSettings = () => {
  if (!canSpeak()) return ($('#vs-status').textContent = 'Reading aloud is not available on this device.');
  $('#vs-engine').innerHTML = '';
  fill(pref('ttsEngine'), pref('ttsVoice'));
};
$('#vs-engine').addEventListener('change', () => {
  setPref('ttsEngine', $('#vs-engine').value);
  setPref('ttsVoice', '');
  fill($('#vs-engine').value, '');
});
$('#vs-voice').addEventListener('change', () => setPref('ttsVoice', $('#vs-voice').value));
$('#vs-test').onclick = () => speak('Hello! This is how replies will sound when I read them aloud.', { voice: $('#vs-voice').value || null, engine: $('#vs-engine').value || null, rate: Number(pref('ttsRate')) || 1 }).catch((e) => toast(e.message));
$('#vs-install').onclick = () => {
  // Android's own "install voice data" screen when there is one, else the store's text-to-speech apps
  if (installVoices) return installVoices().catch((e) => toast(e.message));
  window.open('https://play.google.com/store/search?q=text%20to%20speech%20engine&c=apps', '_blank', 'noopener');
};
