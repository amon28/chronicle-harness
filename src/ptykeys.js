// Keys for the full terminal: the extra row's special keys, and Ctrl/Alt applied to what is typed next.
export const KEYS = { esc: '\x1b', tab: '\t', left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B', home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~' };
/** Ctrl+letter → its control character (Ctrl+[ is Esc, Ctrl+Space is NUL); Alt → ESC prefix. */
export function withMods(data, m) {
  let d = data;
  if (m.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
    else if (d === ' ') d = '\x00';
  }
  if (m.alt) d = '\x1b' + d;
  return d;
}
