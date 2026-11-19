// Syntax highlighting for the file viewer: the language from a file's name (highlight.js, the same as code in chats).
import hljs from 'highlight.js/lib/common';

const ALIASES = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', jsonc: 'json', kt: 'kotlin', rs: 'rust', rb: 'ruby', cs: 'csharp', 'c++': 'cpp' };
// a file's language from its name, for the file viewer (extensions highlight.js knows, plus a few names)
const FILE_NAMES = { dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', '.bashrc': 'bash', '.profile': 'bash', '.zshrc': 'bash', '.gitconfig': 'ini', '.editorconfig': 'ini' };
const FILE_EXT = { mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', mts: 'typescript', pyw: 'python', h: 'c', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', toml: 'ini', cfg: 'ini', conf: 'ini', gradle: 'groovy', kts: 'kotlin', ps1: 'powershell', patch: 'diff', mk: 'makefile', ...ALIASES };
export const FILE_HL_MAX = 200 * 1024; // bigger files are shown plain (highlighting them freezes a phone)
/** The highlight.js language for a file name, or ''. */
export function fileLang(name) {
  const base = String(name || '').split('/').pop().toLowerCase();
  if (FILE_NAMES[base]) return FILE_NAMES[base];
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  const lang = FILE_EXT[ext] || ext;
  const known = lang && hljs.getLanguage(lang);
  return known && !/plain/i.test(known.name || '') ? lang : ''; // .txt is "plain text" to highlight.js
}
/** Highlighted HTML (escaped by highlight.js) for a file's text, or '' when it is not code or too big. */
export function highlightFile(name, text) {
  const lang = fileLang(name);
  if (!lang || text.length > FILE_HL_MAX) return '';
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return '';
  }
}
