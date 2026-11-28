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

/**
 * UTF-16 text (Excel's "Unicode text", some Windows CSV exports): its every other byte is 0, so it looked binary and
 * was refused (decision 275). By its byte-order mark, or – without one, and only for a text file's name (.csv, .txt,
 * code…) – by zeros on one side of nearly every byte pair. → 'utf-16le' | 'utf-16be' | ''
 */
export function utf16Kind(bytes, name = '') {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (!/^(csv|tsv|tab|txt|text|log|json|xml|md|srt|vtt)$/.test(ext(name)) && !langFor(name)) return '';
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 8) return '';
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.9 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.9 && oddZero / pairs < 0.05) return 'utf-16be';
  return '';
}

// how to open a binary data file from /workspace, by its extension (decision 275)
const BINARY_HINT = {
  parquet: 'pandas.read_parquet',
  feather: 'pandas.read_feather',
  sqlite: 'sqlite3.connect',
  sqlite3: 'sqlite3.connect',
  db: 'sqlite3.connect',
  xls: 'pandas.read_excel (old .xls needs xlrd)',
  npy: 'numpy.load',
  npz: 'numpy.load',
  pkl: 'pickle.load (only if you trust where it came from)',
  pickle: 'pickle.load (only if you trust where it came from)',
  gz: 'gzip.open',
  h5: 'h5py or pandas.read_hdf',
  hdf5: 'h5py or pandas.read_hdf',
  mat: 'scipy.io.loadmat',
};

/** A binary file that is not text: it still goes to the workspace, and the model gets a short note about it. */
function binaryAttachment(file, bytes) {
  const e = ext(file.name);
  const hint = BINARY_HINT[e];
  return {
    kind: 'file',
    binary: true,
    name: file.name,
    size: file.size,
    lang: '',
    note: `binary, ${fmtBytes(file.size)}`,
    ...(hint ? { hint } : {}),
    text: `(binary file${e ? ` .${e}` : ''}, ${fmtBytes(file.size)} – not text)`,
    truncated: false,
    bytes,
  };
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
      // under Node (the unit tests) the worker is imported by its package name; in the app, by the built file's URL
      lib.GlobalWorkerOptions.workerSrc = typeof window === 'undefined' ? 'pdfjs-dist/legacy/build/pdf.worker.mjs' : worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

const OFFICE = /^(docx|xlsx|pptx|odt|ods|odp)$/;
const xmlText = (x) => x.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
// Excel keeps a date as a day count (45292 is 2024-01-01) and says only in its style that it is one: the number formats
// that are dates or times – built in (14–22, 27–36, 45–47, 50–58) or a custom code with d/m/y/h/s outside quotes and
// brackets (decision 275)
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);
const fmtKind = (code) => {
  if (/\[(h+|m+|s+)\]/i.test(code)) return ''; // [h]:mm is a duration, not a time of day
  const c = String(code || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if (!/[dmyhs]/i.test(c) || /^[#0.,%\s]*$/.test(c)) return '';
  if (/[dy]/i.test(c)) return /[hs]/i.test(c) ? 'datetime' : 'date';
  return /[hs]/i.test(c) ? 'time' : 'date'; // "mmm" alone is a month
};
/** styles.xml → for each cell style (the s="N" of a cell) '', 'date', 'time' or 'datetime'. */
export function xlsxDateStyles(xml) {
  if (!xml) return [];
  const custom = {};
  for (const m of xml.matchAll(/<numFmt\b[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g)) custom[+m[1]] = fmtKind(xmlText(m[2]));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
  return [...xfs.matchAll(/<xf\b([^>]*)/g)].map((m) => {
    const id = +(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
    if (id in custom) return custom[id];
    return BUILTIN_DATE.has(id) ? (id === 22 ? 'datetime' : 'date') : BUILTIN_TIME.has(id) ? 'time' : '';
  });
}
/** An Excel day count as ISO: 2024-01-01, 2024-01-01 13:30:00, or 13:30:00 for a time. */
export function excelDate(serial, kind, epoch = Date.UTC(1899, 11, 30)) {
  const d = new Date(epoch + Math.round(serial * 86400) * 1000);
  const iso = d.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  if (kind === 'time') return time;
  if (kind === 'datetime' || serial % 1) return `${day} ${time}`;
  return day;
}

/** The text of an Office / OpenDocument file (a zip of XML). → { text, note } */
export function officeToText(bytes, kind) {
  let z;
  try {
    z = unzipSync(bytes);
  } catch {
    return { text: '', note: '' };
  }
  const get = (n) => (z[n] ? new TextDecoder().decode(z[n]) : '');
  const paras = (xml, p, t) => [...xml.matchAll(new RegExp(`<${p}[ >][\\s\\S]*?</${p}>`, 'g'))].map((m) => [...m[0].matchAll(new RegExp(`<${t}(?: [^>]*)?>([^<]*)</${t}>`, 'g'))].map((x) => xmlText(x[1])).join('')).filter((x) => x.trim());
  if (kind === 'docx') {
    const body = get('word/document.xml').replace(/<w:tab\/>/g, '<w:t>\t</w:t>');
    const ps = paras(body, 'w:p', 'w:t');
    return { text: ps.join('\n'), note: `Word document, ${ps.length} paragraph${ps.length === 1 ? '' : 's'}` };
  }
  if (kind === 'pptx') {
    const slides = Object.keys(z).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    const out = slides.map((n, i) => `--- Slide ${i + 1} ---\n${paras(get(n), 'a:p', 'a:t').join('\n')}`);
    return { text: out.join('\n\n'), note: `PowerPoint, ${slides.length} slide${slides.length === 1 ? '' : 's'}` };
  }
  if (kind === 'xlsx') {
    const shared = paras(get('xl/sharedStrings.xml'), 'si', 't');
    const names = [...get('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => xmlText(m[1]));
    const files = Object.keys(z).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    const col = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const asDate = xlsxDateStyles(get('xl/styles.xml'));
    const epoch = /date1904="(1|true)"/.test(get('xl/workbook.xml')) ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const sheets = files.map((n, i) => {
      const rows = [...get(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        const cells = [];
        for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = /r="([A-Z]+\d+)"/.exec(c[1])?.[1];
          const type = /t="(\w+)"/.exec(c[1])?.[1];
          const v = /<v>([^<]*)<\/v>/.exec(c[2] || '')?.[1] ?? /<t[^>]*>([^<]*)<\/t>/.exec(c[2] || '')?.[1] ?? '';
          const style = /\bs="(\d+)"/.exec(c[1])?.[1];
          // a number in a date / time style is shown as an ISO date, not Excel's day count (decision 275)
          const kindOf = style !== undefined && (!type || type === 'n') && v !== '' && Number.isFinite(+v) ? asDate[+style] : '';
          const val = type === 's' ? shared[+v] ?? '' : kindOf ? excelDate(+v, kindOf, epoch) : xmlText(v);
          cells[ref ? col(ref) : cells.length] = /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
        }
        return Array.from(cells, (x) => x ?? '').join(',');
      });
      return `--- Sheet ${names[i] || i + 1} (${rows.length} rows) ---\n${rows.join('\n')}`;
    });
    // what the CSV copy cannot say (decision 275)
    return { text: sheets.join('\n\n'), note: `Excel workbook, ${files.length} sheet${files.length === 1 ? '' : 's'} (as CSV; dates in a date format as ISO dates, other dates may be Excel serial numbers; formulas show their last saved value – for exact values use pandas.read_excel on the .xlsx, import openpyxl first)` };
  }
  // OpenDocument: content.xml, a paragraph per text:p / text:h
  const body = get('content.xml');
  const ps = [...body.matchAll(/<text:(p|h)[^>]*>([\s\S]*?)<\/text:\1>/g)].map((m) => xmlText(m[2])).filter((x) => x.trim());
  return { text: ps.join('\n'), note: `${kind === 'ods' ? 'spreadsheet' : kind === 'odp' ? 'presentation' : 'document'} (OpenDocument), ${ps.length} paragraph${ps.length === 1 ? '' : 's'}` };
}

async function pdfToText(file) {
  return pdfBytesToText(new Uint8Array(await file.arrayBuffer()));
}

/** A PDF's text, page by page (also for fetch_url, decision 270). → { text, pageCount, pagesRead, empty } */
export async function pdfBytesToText(data, max = MAX_TEXT_CHARS) {
  const MAX = max;
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data });
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
    if (total > MAX) break;
  }
  const pageCount = doc.numPages;
  await task.destroy();
  return { text: pages.join('\n\n'), pageCount, pagesRead: pages.length, empty: total === 0 };
}

/**
 * Convert a File into an attachment.
 * Returns { kind:'image', name, src } or { kind:'file', name, size, lang, text, note, truncated }.
 * Throws Error with a user-facing message when the file can't be used.
 */
export async function readAttachment(file, { allowImages, tools = true }) {
  if (isZip(file) && !OFFICE.test(ext(file.name))) return readZip(file);
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
  const office = OFFICE.test(ext(file.name)) ? ext(file.name) : '';
  if (office) {
    // a Word / Excel / PowerPoint file was refused as "binary" (decision 270): its text is read here, and the file
    // itself goes to the workspace like any other (python-docx, openpyxl or the shell can work on it there)
    const r = officeToText(bytes0, office);
    if (!r.text.trim()) throw new Error(`${file.name} has no text the app can read – it is still a ${office} file; attach it in a chat with tools and work on it in the workspace`);
    text = r.text;
    note = r.note;
  } else if (isPdf(file)) {
    const r = await pdfToText(file);
    if (r.empty) throw new Error(`${file.name} has no selectable text (it may be a scanned PDF). Try a screenshot with a vision model instead.`);
    text = r.text;
    // what the text copy leaves out (decision 275)
    note = `PDF, ${r.pageCount} page${r.pageCount === 1 ? '' : 's'}${r.pagesRead < r.pageCount ? `, text of pages 1–${r.pagesRead} only` : ''}, text only – figures, diagrams and the layout of formulas are not included`;
  } else {
    const bytes = bytes0;
    const u16 = utf16Kind(bytes, file.name);
    if (u16) {
      text = new TextDecoder(u16).decode(bytes);
      note = 'UTF-16 text';
    } else if (looksBinary(bytes)) {
      // a small binary data file (parquet, sqlite, .xls, .npy, .pkl, .gz…) goes to the workspace like any other, and the
      // model gets a note where it is – it was refused, while a bigger one worked through the chat's folder (decision 275).
      // Only a chat without tools refuses it: there the model could not open it at all.
      if (!tools) throw new Error(`${file.name} looks like a binary file – the model cannot read it in a chat without tools. Turn 🛠 tools on to let the assistant work on it (with Python) from the workspace.`);
      return binaryAttachment(file, bytes0);
    } else text = new TextDecoder('utf-8').decode(bytes);
  }

  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }
  // a PDF's text goes to the workspace as a .txt beside it: "read it with tools" pointed at the PDF's raw bytes (decision 270)
  return { kind: 'file', name: file.name, size: file.size, lang: isPdf(file) || office ? '' : langFor(file.name), text, note, truncated, bytes: bytes0, ...(isPdf(file) || office ? { textCopy: true } : {}) };
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
  if (f.binary) {
    // a stub, never the bytes (decision 275)
    const how = `read it with run_python${f.hint ? ` (${f.hint})` : ''} or the shell, if it is on`;
    if (toolsOn && f.inWorkspace) return `<file name="${f.name}" path="/workspace/${f.inWorkspace}" info="${f.note || 'binary'}">\nBinary, ${fmtBytes(f.size || 0)}, at /workspace/${f.inWorkspace} – not text: ${how}.\n</file>`;
    return `<file name="${f.name}" info="${f.note || 'binary'}">\n${f.text} – it cannot be read in a chat without tools.\n</file>`;
  }
  if (toolsOn && f.inWorkspace) {
    const big = f.text.length > 30000;
    // the text copy of a PDF is what read_file / grep can read; the PDF itself is named too
    const path = f.textPath || f.inWorkspace;
    const also = f.textPath ? ` – this is its text; the file itself is /workspace/${f.inWorkspace}` : '';
    if (big) return `<file name="${f.name}" path="/workspace/${path}" info="${f.note || ''} ${f.text.length} chars – read it with tools${also}">\n${f.text.slice(0, 4000)}\n…\n</file>`;
  }
  const fence = f.text.includes('```') ? '````' : '```';
  const meta = [f.note, f.truncated ? 'truncated' : ''].filter(Boolean).join(', ');
  return `<file name="${f.name}"${meta ? ` info="${meta}"` : ''}>\n${fence}${f.lang}\n${f.text}\n${fence}\n</file>`;
}

export const approxTokens = (s) => Math.ceil(s.length / 4);
