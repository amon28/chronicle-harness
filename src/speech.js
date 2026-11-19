// Read replies aloud and dictate messages. On Android this uses the native Speech plugin (Android's
// text-to-speech + the system speech recognizer); in a browser, the Web Speech API where it exists.
import { Capacitor, registerPlugin } from '@capacitor/core';

const native = globalThis.__ocmSpeech || (Capacitor.isNativePlatform() ? registerPlugin('Speech') : null); // tests put a stand-in in
const WebRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const canSpeak = () => !!native || (typeof window !== 'undefined' && 'speechSynthesis' in window);
export const canListen = () => !!native || !!WebRecognition;

let current = null; // { id, onEnd }
let seq = 0;
const ended = (id, how = 'done') => {
  if (!current || current.id !== id) return;
  const cb = current.onEnd;
  current = null;
  cb?.(how);
};
native?.addListener('speechDone', (e) => ended(e.id, e.how));

export const isSpeaking = () => !!current;

/** Speak `text` (stops anything already being read). onEnd(how) fires when it finishes or is stopped. */
export async function speak(text, { rate = 1, pitch = 1, onEnd, voice = null, engine = null } = {}) {
  stopSpeaking();
  const id = 's' + ++seq;
  current = { id, onEnd };
  if (native) {
    try {
      await native.speak({ text, rate, pitch, id, voice: voice || undefined, engine: engine || undefined });
    } catch (e) {
      ended(id, 'error');
      throw e;
    }
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  u.pitch = pitch;
  const v = voice && window.speechSynthesis.getVoices?.().find((x) => x.name === voice);
  if (v) u.voice = v;
  u.onend = () => ended(id, 'done');
  u.onerror = () => ended(id, 'error');
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (!current) return;
  const id = current.id;
  if (native) native.stop().catch(() => {});
  else window.speechSynthesis?.cancel();
  ended(id, 'stopped');
}

/** Dictate: resolves the recognised text ('' when cancelled). */
export function listen({ lang } = {}) {
  if (native) return native.listen({ lang: lang || undefined, prompt: 'Speak your message' }).then((r) => r.text || '');
  if (!WebRecognition) return Promise.reject(new Error('Voice input is not available here'));
  return new Promise((resolve, reject) => {
    const r = new WebRecognition();
    r.lang = lang || navigator.language || 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    let text = '';
    r.onresult = (e) => (text = Array.from(e.results).map((x) => x[0].transcript).join(' '));
    r.onerror = (e) => (e.error === 'no-speech' || e.error === 'aborted' ? resolve('') : reject(new Error(e.error || 'Voice input failed')));
    r.onend = () => resolve(text);
    r.start();
  });
}

// ---------- voice mode: listening in the app with live text ----------
export const canListenLive = () => !!native?.startLive || !!WebRecognition;
/** Native: ask for the microphone (voice mode only). → true when allowed. */
export async function micPermission() {
  if (!native) return !!WebRecognition;
  if (!native.micPermission) return false;
  return !!(await native.micPermission())?.granted;
}
let liveSubs = [];
const unsub = () => {
  liveSubs.forEach((h) => Promise.resolve(h).then((x) => x?.remove?.()).catch(() => {}));
  liveSubs = [];
};
/**
 * Listen once, without a dialog. onPartial(text) while you talk, onLevel(0..1) for the meter.
 * → { promise: text ('' after silence), stop() }.
 */
export function listenLive({ lang, onPartial, onLevel } = {}) {
  let stop = () => {};
  const promise = new Promise((resolve, reject) => {
    if (native?.startLive) {
      unsub();
      let last = '';
      const done = (fn) => (unsub(), fn());
      liveSubs.push(
        native.addListener('livePartial', (e) => ((last = e.text || last), onPartial?.(last))),
        native.addListener('liveLevel', (e) => onLevel?.(Math.max(0, Math.min(1, (Number(e.rms) + 2) / 12)))),
        native.addListener('liveResult', (e) => done(() => resolve(String(e.text || last || '')))),
        native.addListener('liveEnd', (e) => done(() => (e.error === 'silence' ? resolve(last) : reject(new Error(`Voice input failed (${e.error})`))))),
      );
      stop = () => (native.stopLive().catch(() => {}), done(() => resolve(last)));
      native.startLive({ lang: lang || undefined }).catch((e) => done(() => reject(e)));
      return;
    }
    if (!WebRecognition) return reject(new Error('Voice input is not available here'));
    const r = new WebRecognition();
    r.lang = lang || navigator.language || 'en-US';
    r.interimResults = true;
    r.maxAlternatives = 1;
    let text = '';
    r.onresult = (e) => {
      text = Array.from(e.results).map((x) => x[0].transcript).join(' ');
      onPartial?.(text);
    };
    r.onerror = (e) => (e.error === 'no-speech' || e.error === 'aborted' ? resolve(text) : reject(new Error(e.error || 'Voice input failed')));
    r.onend = () => resolve(text);
    stop = () => r.stop();
    r.start();
  });
  return { promise, stop: () => stop() };
}

/**
 * The finished sentences of a reply that is still being written, from `from` on: → { text, upto }.
 * Code blocks are skipped (an open one stops it); a sentence ends at . ! ? … followed by space, or a blank line.
 */
export function nextSpeakable(md, from = 0) {
  const s = String(md || '');
  const fences = [...s.matchAll(/^[ \t]*(```|~~~)/gm)].map((m) => m.index);
  let end = -1;
  const rx = /[.!?…]["”’*)\]]*\s|\n\s*\n/g;
  rx.lastIndex = from;
  for (let m; (m = rx.exec(s)); ) {
    const at = m.index + m[0].length;
    if (fences.filter((f) => f < at).length % 2) break; // inside an open code block
    end = at;
  }
  if (end <= from) return { text: '', upto: from };
  return { text: s.slice(from, end), upto: end };
}

/**
 * Markdown reply → what to read aloud: no code blocks, links, markup or emoji.
 * dialogueOnly: in roleplay, read just the quoted speech (falls back to everything if there is none).
 */
export function speechText(md, { dialogueOnly = false, skipActions = false } = {}) {
  let t = String(md || '');
  // *actions* (roleplay narration between single asterisks) left out; **bold** is kept
  if (skipActions) t = t.replace(/\*\*([^*\n]+)\*\*/g, '\u0001$1\u0001').replace(/(^|[^*])\*[^*\n]+\*(?!\*)/g, '$1 ').replace(/\u0001/g, '');
  t = t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~#|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
  if (dialogueOnly) {
    const said = [...t.matchAll(/[“"«]([^”"»]{2,})[”"»]/g)].map((m) => m[1].trim());
    if (said.length) t = said.join(' … ');
  }
  return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Installed engines and the voices of one engine. → { engines: [{name, label}], engine, voices: [{name, lang, network}] }
 * On Android, "engines" are TTS apps (Google, Samsung, a voice-cloning app like CloneTTS…).
 */
export async function listVoices(engine = null) {
  if (native) return native.voices({ engine: engine || undefined });
  const get = () => window.speechSynthesis?.getVoices?.() || [];
  let vs = get();
  if (!vs.length && window.speechSynthesis) {
    await new Promise((r) => {
      window.speechSynthesis.onvoiceschanged = r;
      setTimeout(r, 800);
    });
    vs = get();
  }
  return { engines: [{ name: 'browser', label: 'This browser' }], engine: 'browser', voices: vs.map((v) => ({ name: v.name, lang: v.lang, network: !v.localService })) };
}

/** Android: the screen where more voices are installed (null elsewhere). */
export const installVoices = native?.installVoices ? () => native.installVoices() : null;
