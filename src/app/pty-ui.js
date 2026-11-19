// 🖥 Full terminal: a real terminal (xterm.js) for full-screen programs – vim, htop, less, nano – in the built-in
// Linux. Keys go to the program as you type; the row above the keyboard has the keys a phone keyboard lacks.
import { $, hooks, toast } from './core.js';
import { canPty, LOGIN_SHELL, onPty, ptyKill, ptyResize, ptyStart, ptyWrite } from '../shell.js';
import { KEYS, withMods } from '../ptykeys.js';

const ID = 'fullterm';
let term = null;
let fit = null;
let off = null;
let mods = { ctrl: false, alt: false };
let ro = null;

function send(data) {
  const d = withMods(data, mods);
  if (mods.ctrl || mods.alt) {
    mods = { ctrl: false, alt: false };
    document.querySelectorAll('#pty-keys .mod').forEach((b) => b.classList.remove('on'));
  }
  ptyWrite(ID, d).catch(() => {});
}

/** prefill: text typed at the prompt without Enter (the user runs it) – e.g. `claude` from Settings › Claude Code in Linux. */
async function open(cmd = LOGIN_SHELL, title = 'Terminal', { prefill = '' } = {}) {
  if (!canPty()) return toast('The full terminal needs the Android app with Linux installed');
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
  await import('@xterm/xterm/css/xterm.css');
  $('#pty-view').hidden = false;
  $('#pty-title').textContent = title;
  document.body.classList.add('pty-on');
  term?.dispose();
  term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace', cursorBlink: true, scrollback: 5000, theme: { background: '#0b0d10' } });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('#pty-term'));
  fit.fit();
  off?.();
  off = await onPty(
    (e) => e.id === ID && term?.write(Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0))),
    (e) => {
      if (e.id !== ID) return;
      ended = true;
      const quick = Date.now() - startedAt < 2500;
      term?.write(`\r\n\x1b[2m[ended${e.code ? ' with code ' + e.code : ''} – ${quick ? 'the full terminal could not start on this phone: use ☰ Command box (top right) instead' : 'Close, or press Enter to start again'}]\x1b[0m\r\n`);
    },
  );
  let ended = false;
  term.onData((d) => {
    if (ended && d === '\r') {
      ended = false;
      return start();
    }
    send(d);
  });
  let startedAt = Date.now();
  const start = () => ((startedAt = Date.now()), ptyStart({ id: ID, cmd, cols: term.cols, rows: term.rows }).catch((e) => term.write(`\r\n${e.message}\r\n`)));
  await start();
  if (prefill) setTimeout(() => !ended && ptyWrite(ID, String(prefill).replace(/[\r\n]/g, '')).catch(() => {}), 700);
  ro?.disconnect();
  let t = 0;
  ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!term) return;
      fit.fit();
      ptyResize(ID, term.cols, term.rows)?.catch?.(() => {});
    }, 200);
  });
  ro.observe($('#pty-term'));
  term.focus();
}

/**
 * Swipe to scroll anywhere on the terminal (decision 191). xterm.js only scrolls when the finger lands on its bare
 * background: on the text it starts a selection, so a full screen could hardly be scrolled. A vertical swipe now
 * scrolls the history (with a little momentum after a flick); in a full-screen program (less, vim, htop – the
 * alternate screen, which has no history) it sends ↑ / ↓ as Termux does. A tap still focuses the terminal.
 */
function touchScroll(el) {
  let y0 = null;
  let x0 = 0;
  let last = 0;
  let lastAt = 0;
  let carry = 0;
  let v = 0; // px per ms, for the flick
  let raf = 0;
  let moved = false;
  const cell = () => {
    const screen = el.querySelector('.xterm-screen');
    return Math.max(8, (screen?.clientHeight || el.clientHeight) / Math.max(1, term?.rows || 24));
  };
  const scrollBy = (px) => {
    if (!term) return;
    carry += px;
    const lines = Math.trunc(carry / cell());
    if (!lines) return;
    carry -= lines * cell();
    if (term.buffer.active.type === 'alternate') send((lines > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.min(Math.abs(lines), 20)));
    else term.scrollLines(lines);
  };
  el.addEventListener(
    'touchstart',
    (e) => {
      cancelAnimationFrame(raf);
      if (e.touches.length !== 1) return (y0 = null);
      y0 = last = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      lastAt = performance.now();
      carry = v = 0;
      moved = false;
    },
    { capture: true, passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (y0 == null || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!moved && Math.abs(t.clientY - y0) < 8) return;
      if (!moved && Math.abs(t.clientX - x0) > Math.abs(t.clientY - y0)) return (y0 = null); // sideways: not a scroll
      moved = true;
      e.preventDefault(); // not a selection, not the page
      e.stopPropagation();
      const now = performance.now();
      const dy = last - t.clientY; // finger up = later lines
      v = dy / Math.max(1, now - lastAt);
      last = t.clientY;
      lastAt = now;
      scrollBy(dy);
    },
    { capture: true, passive: false },
  );
  el.addEventListener(
    'touchend',
    (e) => {
      if (y0 == null) return;
      y0 = null;
      if (!moved) return; // a tap: xterm focuses as before
      e.preventDefault();
      // the flick: slows down over about half a second
      let t0 = performance.now();
      const step = (now) => {
        const dt = now - t0;
        t0 = now;
        v *= Math.pow(0.995, dt);
        if (Math.abs(v) < 0.05) return;
        scrollBy(v * dt);
        raf = requestAnimationFrame(step);
      };
      if (Math.abs(v) > 0.3) raf = requestAnimationFrame(step);
    },
    { capture: true, passive: false },
  );
}
touchScroll($('#pty-term'));
function close() {
  ptyKill(ID).catch(() => {});
  off?.();
  ro?.disconnect();
  term?.dispose();
  term = null;
  $('#pty-view').hidden = true;
  document.body.classList.remove('pty-on');
}
hooks.openFullTerminal = open;

$('#pty-close').onclick = close;
$('#pty-simple').onclick = () => {
  close();
  hooks.openSimpleTerminal?.();
};
$('#pty-keys').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const k = b.dataset.k;
  if (k === 'ctrl' || k === 'alt') {
    mods[k] = !mods[k];
    b.classList.toggle('on', mods[k]);
  } else send(KEYS[k] || k);
  term?.focus();
});
$('#term-full').onclick = () => open();
