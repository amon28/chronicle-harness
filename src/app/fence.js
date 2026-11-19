// Typing ``` + a language in the message box opens a code box: Enter on that line adds the closing ``` and a free
// line below it. While the caret is inside the box the message field itself turns into a code box (monospace, dark,
// no autocorrect) with a small bar: language, Wrap on/off, and Done to step out below the box.

const FENCE = /^```([\w+#.-]*)$/;

/** → the new text and caret when Enter is pressed on an opening fence line, else null. Pure, for tests. */
export function openFence(text, caret) {
  const start = text.lastIndexOf('\n', caret - 1) + 1;
  const line = text.slice(start, caret);
  const m = FENCE.exec(line);
  if (!m) return null;
  // an odd number of fences before this line means it closes a box instead
  const before = text.slice(0, start).split('\n').filter((l) => /^```/.test(l)).length;
  if (before % 2 === 1) return null;
  const rest = text.slice(caret);
  const next = rest.startsWith('\n') ? rest.slice(1) : rest;
  const insert = '\n\n```\n';
  // already a closing fence right below? leave it, just add the line for the code
  if (/^```\s*(\n|$)/.test(next)) return { text: text.slice(0, caret) + '\n' + rest, caret: caret + 1 };
  return { text: text.slice(0, caret) + insert + rest.replace(/^\n/, ''), caret: caret + 1 };
}

/** Is the caret inside a fenced block? → { lang, bodyStart, close } (close = index just after the closing fence line, or -1 if unclosed). */
export function fenceAt(text, caret) {
  let pos = 0;
  let open = null;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (/^```/.test(line)) {
      if (!open) open = { lang: line.slice(3).trim(), bodyStart: end + 1, from: pos };
      else {
        if (caret > open.from && caret <= end) return { lang: open.lang, bodyStart: open.bodyStart, close: Math.min(text.length, end + 1) };
        open = null;
      }
    }
    pos = end + 1;
  }
  if (open && caret > open.from) return { lang: open.lang, bodyStart: open.bodyStart, close: -1 };
  return null;
}

export function setupFence(input, { onChange }) {
  const bar = document.getElementById('compose-preview');
  let wrap = true;
  const label = document.createElement('span');
  label.className = 'cb-label';
  const wrapBtn = document.createElement('button');
  wrapBtn.type = 'button';
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.textContent = 'Done';
  bar.append(label, wrapBtn, doneBtn);
  const paintWrap = () => {
    wrapBtn.textContent = wrap ? '↵ Wrap: on' : '↵ Wrap: off';
    input.classList.toggle('nowrap', !wrap);
  };
  paintWrap();
  // keep the keyboard up while tapping the bar's buttons
  for (const b of [wrapBtn, doneBtn]) b.addEventListener('mousedown', (e) => e.preventDefault());
  wrapBtn.onclick = () => {
    wrap = !wrap;
    paintWrap();
  };
  doneBtn.onclick = () => {
    const f = fenceAt(input.value, input.selectionStart);
    if (!f) return;
    let v = input.value;
    let at = f.close;
    if (at < 0) {
      v = v.replace(/\n?$/, '\n') + '```\n';
      at = v.length;
    } else if (at >= v.length) {
      v += v.endsWith('\n') ? '' : '\n';
      at = v.length;
    }
    input.value = v;
    input.setSelectionRange(at, at);
    input.focus();
    onChange?.();
    refresh();
  };
  const refresh = () => {
    const f = fenceAt(input.value, input.selectionStart ?? 0);
    bar.hidden = !f;
    input.classList.toggle('in-code', !!f);
    if (f) label.textContent = `code${f.lang ? ' · ' + f.lang : ''}`;
    input.autocapitalize = f ? 'off' : 'sentences';
    input.spellcheck = !f;
  };
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    if (input.selectionStart !== input.selectionEnd) return;
    const r = openFence(input.value, input.selectionStart);
    if (!r) return;
    e.preventDefault();
    input.value = r.text;
    input.setSelectionRange(r.caret, r.caret);
    onChange?.();
    refresh();
  });
  input.addEventListener('input', refresh);
  for (const ev of ['keyup', 'click', 'focus']) input.addEventListener(ev, refresh);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === input) refresh();
  });
  return { refresh };
}
