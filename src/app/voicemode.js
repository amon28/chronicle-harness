// Voice mode: a hands-free conversation. Listen (live text on screen) → send → read the reply aloud sentence
// by sentence while it is still being written → listen again. Tap the circle to interrupt the reply and talk,
// or to send what you said; two silences in a row pause it.
import { $, chatPersona, hooks, personaById, pref, state, toast } from './core.js';
import { canListen, canListenLive, listen, listenLive, micPermission, nextSpeakable, speak, speechText, stopSpeaking } from '../speech.js';
import { stripChoices } from '../choices.js';
import { autoGrow, input, isRpConv, send, stopStream } from './engine.js';

const V = { active: false, phase: 'idle', live: null, silences: 0, inline: true };
hooks.voiceActive = () => V.active;

const ui = () => $('#voice-mode');
function show(phase, text = '') {
  V.phase = phase;
  const box = ui();
  box.dataset.phase = phase;
  $('#vm-status').textContent = { listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking – tap to interrupt', paused: 'Paused – tap to talk', idle: '' }[phase] || '';
  if (text !== null) $('#vm-text').textContent = text;
}
const level = (x) => ui().style.setProperty('--vm-level', String(x));

async function turn() {
  if (!V.active) return;
  show('listening', '');
  let text = '';
  try {
    if (V.inline) {
      V.live = listenLive({ onPartial: (t) => ($('#vm-text').textContent = t), onLevel: level });
      text = (await V.live.promise).trim();
    } else text = (await listen()).trim(); // no microphone permission: the system's own listening screen
  } catch (e) {
    if (!V.active) return;
    toast(e.message || 'Voice input failed', 3500);
    return show('paused', '');
  } finally {
    V.live = null;
    level(0);
  }
  if (!V.active) return;
  if (!text) {
    V.silences++;
    if (V.silences >= 2) return show('paused', '');
    return turn();
  }
  V.silences = 0;
  if (/^(stop|end|exit|goodbye)( voice( mode)?)?[.!]?$/i.test(text)) return end();
  await converse(text);
}

/** Send what was said and read the new replies aloud as they arrive, then listen again. */
async function converse(text) {
  const conv = state.current;
  const from = conv.messages.length;
  input.value = text;
  autoGrow();
  show('thinking', text);
  send();
  const spoken = new Map(); // message → how much of its text has been read
  let idle = 0;
  for (;;) {
    if (!V.active || state.current !== conv) return;
    const running = state.runs.has(conv.id);
    const msgs = conv.messages.slice(from).filter((m) => m.role === 'assistant');
    let said = false;
    for (const m of msgs) {
      const body = stripChoices(m.content || '');
      const at = spoken.get(m) || 0;
      const chunk = m.streaming ? nextSpeakable(body, at) : { text: body.slice(at), upto: body.length };
      if (!chunk.text.trim()) continue;
      spoken.set(m, chunk.upto);
      const words = speechText(chunk.text, { dialogueOnly: pref('ttsDialogue') && isRpConv(conv, personaById(m.personaId) || chatPersona(conv)), skipActions: pref('ttsSkipActions') });
      if (!words) continue;
      said = true;
      show('speaking', null);
      const how = await say(words, personaById(m.personaId) || chatPersona(conv));
      if (how === 'stopped' || !V.active) return; // interrupted: the tap handler takes over
      break; // look again: more may have arrived meanwhile
    }
    if (said) continue;
    const allDone = !running && msgs.every((m) => !m.streaming && (spoken.get(m) || 0) >= stripChoices(m.content || '').length);
    if (allDone && (msgs.length || ++idle > 20)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const last = conv.messages[conv.messages.length - 1];
  if (last?.error) {
    toast('The reply failed – voice mode paused', 3500);
    return show('paused', '');
  }
  turn();
}

function say(text, who) {
  return new Promise((resolve) => {
    speak(text, { rate: Number(pref('ttsRate')) || 1, voice: who?.voice?.name || (who?.voice?.engine ? null : pref('ttsVoice')) || null, engine: who?.voice?.engine || pref('ttsEngine') || null, onEnd: resolve }).catch(() => resolve('error'));
  });
}

async function start() {
  if (V.active) return;
  if (!canListen()) return toast('Voice input is not available on this device');
  V.inline = canListenLive() && (await micPermission().catch(() => false));
  if (!V.inline) toast('Without the microphone permission, each turn uses Android’s listening screen', 3500);
  V.active = true;
  V.silences = 0;
  ui().hidden = false;
  document.body.classList.add('voice-on');
  $('#vm-who').textContent = chatPersona()?.name || 'Assistant';
  turn();
}
function end() {
  V.active = false;
  V.live?.stop();
  stopSpeaking();
  ui().hidden = true;
  document.body.classList.remove('voice-on');
  show('idle', '');
}
hooks.startVoice = start;

$('#vm-orb').onclick = () => {
  if (V.phase === 'speaking') {
    stopSpeaking();
    if (state.runs.has(state.current?.id)) stopStream();
    V.silences = 0;
    return turn();
  }
  if (V.phase === 'listening') return V.live?.stop(); // send what was heard so far
  if (V.phase === 'paused') {
    V.silences = 0;
    return turn();
  }
};
$('#vm-end').onclick = end;
document.addEventListener('visibilitychange', () => document.hidden && V.active && V.phase === 'listening' && V.live?.stop());

export { start as startVoiceMode, end as endVoiceMode };
