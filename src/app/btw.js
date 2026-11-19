// /btw <question>: a quick side question about the chat, answered in a bubble above the message box. It is one
// request with this chat's context and no tools; the answer is never added to the conversation, so later replies do
// not see it, and a reply that is running goes on undisturbed (its own request, its own session id).
import { streamChat } from '../api.js';
import { $, currentModel, el, hooks, renderMarkdown, state, toast, toolsOn } from './core.js';
import { apiMessages } from './engine.js';
import { wsMem } from './extras.js';
import { btwMessages } from '../sidequestion.js';

let open = null; // { cancel, node }
function close() {
  open?.cancel?.();
  open?.node.remove();
  open = null;
}

/**
 * Ask it. The chat's own model answers: it already holds this context (the prompt cache of the running reply is
 * warm for it, and its window fits the chat), where the helper model might be smaller or slower to read it all.
 */
export function sideQuestion(conv, question) {
  const q = String(question || '').trim();
  if (!q) return toast('Write your question after /btw, e.g. /btw what does that error mean?');
  if (!conv?.messages?.length) return toast('Nothing to ask about yet – /btw asks about this chat');
  close();
  const model = conv.model || currentModel();
  const agent = toolsOn(conv) && state.models.find((x) => x.id === model)?.capabilities?.tools?.supported !== false;
  // building the prompt must not move anything the real reply keeps (the lore timers, the window)
  const keep = { lore: conv._loreTimersNext, win: conv.windowStart };
  let history;
  try {
    history = apiMessages(conv, { agent, wsCount: Object.keys(wsMem.get(conv.id)?.files || {}).length, modelId: model });
  } finally {
    conv._loreTimersNext = keep.lore;
    if (keep.win === undefined) delete conv.windowStart;
    else conv.windowStart = keep.win;
  }
  const node = el('div', 'btw-panel');
  node.id = 'btw-panel';
  const head = el('div', 'btw-head');
  head.append(el('span', 'btw-q', `💬 By the way: ${q.slice(0, 200)}`));
  const x = el('button', 'icon-btn small btw-close', '×');
  x.setAttribute('aria-label', 'Close');
  x.onclick = close;
  head.append(x);
  const body = el('div', 'md btw-body');
  body.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  node.append(head, body, el('div', 'btw-foot', 'Not added to the chat · the assistant will not see this'));
  $('.composer-wrap').prepend(node);
  let text = '';
  const mine = { node };
  open = mine;
  const h = streamChat(state.settings, { model, messages: btwMessages(history, q), sessionId: conv.id + '-btw', temperature: 0.3, kind: 'helper' }, {
    onContent: (t) => {
      text += t;
      if (open === mine) body.innerHTML = renderMarkdown(text);
    },
    onReasoning: () => {},
    onDone: () => {
      if (open === mine && !text.trim()) body.textContent = '(no answer)';
    },
    onError: (e) => {
      if (open === mine) body.textContent = `Could not answer: ${String(e?.message || e).slice(0, 200)}`;
    },
  });
  mine.cancel = () => h?.cancel?.();
}
hooks.sideQuestion = sideQuestion;
