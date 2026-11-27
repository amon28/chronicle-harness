// Turning picked files into chat attachments.
//  - images  → resized JPEG data URLs (sent as image parts to vision models)
//  - PDFs    → text extracted on-device with pdf.js (works with every model)
//  - text / code / data files → read as UTF-8 text
// Text attachments are inlined into the user message, like pasting the file.

import { unzipSync } from 'fflate';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // refuse anything bigger
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_FILES = 3000;
export const MAX_TEXT_CHARS = 400_000; // ~100K tokens per file, then truncate

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte', json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', md: 'markdown', mdx: 'markdown',
  csv: 'csv', ini: 'ini', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', ex: 'elixir',
  exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', zig: 'zig', nim: 'nim', gradle: 'groovy',
  groovy: 'groovy', tf: 'hcl', dockerfile: 'dockerfile', makefile: 'makefile', diff: 'diff', patch: 'diff',
};

const ext = (name) => {
  const base = name.toLowerCase().split('/').pop();
  if (base === 'dockerfile' || base === 'makefile') return base;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
};

export const langFor = (name) => LANG[ext(name)] || '';

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const isZip = (f) => /zip/.test(f.type) || ext(f.name) === 'zip';
const isPdf = (f) => f.type === 'application/pdf' || ext(f.name) === 'pdf';
const isImage = (f) => f.type.startsWith('image/') && !/svg/.test(f.type);

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) odd++;
  }
  return n > 0 && odd / n > 0.1;
}

const toDataUrl = (bytes, mime) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
};

/**
 * What the model sees of an attached picture. A small one (pixel art, an icon, a screenshot under the size cap) is
 * sent exactly as it is – a PNG keeps its pixels and its transparency. A big one is scaled down to JPEG for the
 * model, and the result says so. → { src, note }
 */
function resizeImage(file, max = 1536, bytes = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const lossless = /png|gif|webp/.test(file.type);
      if (bytes && Math.max(img.width, img.height) <= max && bytes.length <= 4 * 1024 * 1024) {
        URL.revokeObjectURL(img.src);
        return resolve({ src: toDataUrl(bytes, file.type || 'image/png'), note: '', width: img.width, height: img.height });
      }
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      const w = c.width, h = c.height;
      resolve({ src: c.toDataURL('image/jpeg', 0.85), note: `shown to the model scaled to ${w}×${h} JPEG (the original ${img.width}×${img.height}${lossless ? ' ' + file.type.replace('image/', '').toUpperCase() + ', transparency included' : ''} is kept as it is in the workspace)`, width: img.width, height: img.height });
    };
    img.onerror = () => reject(new Error('Could not read image'));
    img.src = URL.createObjectURL(file);
  });
}

let pdfjsPromise;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

async function pdfToText(file) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages = [];
  let total = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim();
    pages.push(`--- Page ${p} ---\n${text}`);
    total += text.length;
    if (total > MAX_TEXT_CHARS) break;
  }
  const pageCount = doc.numPages;
  await task.destroy();
  return { text: pages.join('\n\n'), pageCount, empty: total === 0 };
}

/**
 * Convert a File into an attachment.
 * Returns { kind:'image', name, src } or { kind:'file', name, size, lang, text, note, truncated }.
 * Throws Error with a user-facing message when the file can't be used.
 */
export async function readAttachment(file, { allowImages }) {
  if (isZip(file)) return readZip(file);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is too large to attach (${fmtBytes(file.size)}, max 10 MB) – on the phone, 📎 › Attach a file or image takes any size (a big file goes into the chat's folder)`);

  if (isImage(file)) {
    if (!allowImages) throw new Error(`This model can't see images – pick a model with the "vision" badge to send ${file.name}`);
    // the original bytes go to the workspace untouched (an attached PNG is never turned into a JPEG there)
    const orig = new Uint8Array(await file.arrayBuffer());
    const r = await resizeImage(file, 1536, orig);
    return { kind: 'image', name: file.name, src: r.src, bytes: orig, mime: file.type, note: r.note };
  }

  let text;
  let note = '';
  const bytes0 = new Uint8Array(await file.arrayBuffer());
  if (isPdf(file)) {
    const r = await pdfToText(file);
    if (r.empty) throw new Error(`${file.name} has no selectable text (it may be a scanned PDF). Try a screenshot with a vision model instead.`);
    text = r.text;
    note = `PDF, ${r.pageCount} page${r.pageCount === 1 ? '' : 's'}`;
  } else {
    const bytes = bytes0;
    if (looksBinary(bytes)) throw new Error(`${file.name} looks like a binary file – only text, code and PDF files can be attached`);
    text = new TextDecoder('utf-8').decode(bytes);
  }

  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }
  return { kind: 'file', name: file.name, size: file.size, lang: isPdf(file) ? '' : langFor(file.name), text, note, truncated, bytes: bytes0 };
}

/** Extract a zip. Text files are also inlined (up to a budget) for chats without tools. */
async function readZip(file) {
  if (file.size > MAX_ZIP_BYTES) throw new Error(`${file.name} is too large (${fmtBytes(file.size)}, max 50 MB)`);
  let entries;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error(`${file.name} isn't a valid zip file`);
  }
  const files = Object.entries(entries)
    .filter(([p, d]) => !p.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store|\.git)(\/|$)/.test(p) && d.length)
    .slice(0, MAX_ZIP_FILES)
    .map(([path, data]) => ({ path, data }));
  if (!files.length) throw new Error(`${file.name} is empty`);
  const folder = file.name.replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '_') || 'archive';
  const total = files.reduce((n, f) => n + f.data.length, 0);
  const listing = files.map((f) => `${folder}/${f.path} (${fmtBytes(f.data.length)})`).join('\n');
  // inline text files for models without tools
  let budget = MAX_TEXT_CHARS;
  const inlined = [];
  for (const f of files) {
    if (budget <= 0 || looksBinary(f.data)) continue;
    const t = new TextDecoder().decode(f.data).slice(0, budget);
    budget -= t.length;
    inlined.push(`<file name="${folder}/${f.path}">\n${t}\n</file>`);
  }
  return {
    kind: 'file',
    zip: true,
    name: file.name,
    size: file.size,
    folder,
    note: `ZIP, ${files.length} file${files.length === 1 ? '' : 's'}, ${fmtBytes(total)}`,
    listing,
    text: inlined.join('\n\n'),
    truncated: budget <= 0,
    lang: '',
    entries: files,
  };
}

/** How a text attachment is presented to the model inside the user message. */
export function fileToPrompt(f, toolsOn) {
  if (f.video) return `<video name="${f.name}" info="${f.note || ''}">\n${f.text}\n</video>`; // recorded into the chat's folder (decision 229)
  if (f.inFolder) return `<file name="${f.name}" info="${f.note || ''}">\n${f.text}\n</file>`; // a big file put in the chat's folder (decision 249)
  if (f.zip) {
    if (toolsOn) return `<archive name="${f.name}" extracted_to="/workspace/${f.folder}/" info="${f.note}">\n${f.listing.split('\n').slice(0, 300).join('\n')}\n</archive>`;
    return `<archive name="${f.name}" info="${f.note}${f.truncated ? ', text truncated' : ''}">\n${f.text || '(no text files)'}\n</archive>`;
  }
  if (toolsOn && f.inWorkspace) {
    const big = f.text.length > 30000;
    if (big) return `<file name="${f.name}" path="/workspace/${f.inWorkspace}" info="${f.note || ''} ${f.text.length} chars – read it with tools">\n${f.text.slice(0, 4000)}\n…\n</file>`;
  }
  const fence = f.text.includes('```') ? '````' : '```';
  const meta = [f.note, f.truncated ? 'truncated' : ''].filter(Boolean).join(', ');
  return `<file name="${f.name}"${meta ? ` info="${meta}"` : ''}>\n${fence}${f.lang}\n${f.text}\n${fence}\n</file>`;
}

export const approxTokens = (s) => Math.ceil(s.length / 4);
