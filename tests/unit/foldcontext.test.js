import { describe, it, expect } from 'vitest';
import { structuredRecord, deadWeight, pruneCut, todoNote, roundTodoNote, TODO_EVERY, compactStyleOf, clipArgs, keyArg, STUB_REPEAT, PRUNE_RECENT, USER_CLIP } from '../../src/foldcontext.js';
import { chatTranscript } from '../../src/context.js';

const call = (name, args, result, status = 'done', extra = {}) => ({ id: 'c' + Math.random().toString(36).slice(2, 7), name, arguments: JSON.stringify(args), result, status, ...extra });
const reply = (calls, content = '', extra = {}) => ({ role: 'assistant', content, rounds: calls.length ? [{ content: '', calls }] : [], ...extra });
const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
const BIG = 'x'.repeat(2000);

// an agent chat as the app stores it: rounds of calls with their results, a picture, an attachment, a failure
function agentChat() {
  return [
    user('Build me a small todo web app in /workspace/app. Use plain JS.', { images: ['data:image/png;base64,AAA'], imagePaths: ['uploads/sketch.png'] }),
    reply([call('list_files', { path: '' }, '(empty)'), call('write_file', { path: 'app/index.html', content: '<html></html>' }, 'Wrote app/index.html (13 chars).')], 'Started with the page.'),
    user('Add a test and run it', { files: [{ name: 'spec.txt' }] }),
    reply([
      call('write_file', { path: 'app/test.js', content: 'test' }, 'Wrote app/test.js (4 chars).'),
      call('shell', { command: 'cd app && node test.js' }, 'exit code 1\nError: boom', 'error'),
      call('edit_file', { path: 'app/index.html', old_text: '<html>', new_text: '<html lang="en">' }, 'Edited app/index.html'),
      call('shell', { command: 'cd app && node test.js' }, 'exit code 0\nall good'),
      call('fetch_url', { urls: ['https://developer.mozilla.org/en-US/docs/Web/API/localStorage'] }, 'localStorage docs…'),
      call('web_search', { query: 'localStorage quota' }, '5 MB'),
      call('delete_file', { path: 'app/old.js' }, 'Deleted app/old.js'),
      call('move_file', { from: 'app/a.css', to: 'app/style.css' }, 'Moved'),
      call('apply_patch', { patch: '*** Begin Patch\n*** Add File: app/util.js\n+export const x = 1;\n*** Update File: app/test.js\n@@\n-test\n+test2\n*** End Patch' }, 'Patch applied (2 files)'),
    ], 'Tests pass now.'),
    user('L'.repeat(USER_CLIP + 500)),
    reply([], '', { error: 'Network error' }),
  ];
}

describe('structured compaction record', () => {
  const msgs = agentChat();
  const rec = structuredRecord(msgs, { from: 0, to: msgs.length, todos: [{ text: 'write tests', status: 'done' }, { text: 'style it', status: 'in_progress' }] });
  it('quotes every user message verbatim, with pictures and attachments named', () => {
    expect(rec).toContain('#0: Build me a small todo web app in /workspace/app. Use plain JS. [1 image (uploads/sketch.png)]');
    expect(rec).toContain('#2: Add a test and run it [attached spec.txt]');
  });
  it('clips a long user message with a marker that says how to read it all', () => {
    expect(rec).toContain(`#4: ${'L'.repeat(USER_CLIP)}… [500 more chars – read_chat with id "this" and from=4 shows it in full]`);
    expect(rec).not.toContain('L'.repeat(USER_CLIP + 1));
  });
  it('lists the files created, changed and deleted', () => {
    expect(rec).toMatch(/created: app\/index\.html, app\/test\.js, app\/style\.css, app\/util\.js/);
    expect(rec).toMatch(/deleted: app\/old\.js, app\/a\.css/);
    const r2 = structuredRecord([reply([call('write_file', { path: 'a.txt', content: 'b' }, 'Wrote a.txt (1 chars).', 'done', { display: { diff: [1] } }), call('edit_file', { path: 'b.txt' }, 'Edited')])]);
    expect(r2).toMatch(/changed: a\.txt, b\.txt/);
  });
  it('lists commands with their exit status, one line each', () => {
    expect(rec).toContain('#3 $ cd app && node test.js → exit 1, failed');
    expect(rec).toContain('#3 $ cd app && node test.js → exit 0');
  });
  it('keeps errors, URLs, searches, the tool steps and the open to-do list', () => {
    expect(rec).toMatch(/## Errors seen\n#3 shell cd app && node test\.js: exit code 1\n#5 the reply stopped: Network error/);
    expect(rec).toContain('https://developer.mozilla.org/en-US/docs/Web/API/localStorage');
    expect(rec).toContain('searched: localStorage quota');
    expect(rec).toMatch(/#1: list_files ✓ · write_file app\/index\.html ✓/);
    expect(rec).toMatch(/shell cd app && node test\.js ✗/);
    expect(rec).toMatch(/## Open to-do list \/ plan\n\[Reminder[^\n]*\]\nTo-do list:\n- \[x\] write tests\n- \[>\] style it/);
  });
  it('is deterministic and does not touch the messages', () => {
    const before = JSON.stringify(msgs);
    expect(structuredRecord(msgs, { todos: [{ text: 'a', status: 'pending' }] })).toBe(structuredRecord(msgs, { todos: [{ text: 'a', status: 'pending' }] }));
    expect(JSON.stringify(msgs)).toBe(before);
  });
  it('only takes the folded range, keeps an earlier record in front and the focus', () => {
    const r = structuredRecord(msgs, { from: 2, to: 4, prev: 'EARLIER STUFF', focus: 'the test command' });
    expect(r).toMatch(/^\[Structured record of messages #2–#3/);
    expect(r).toContain('## Earlier record\nEARLIER STUFF');
    expect(r).toContain('the test command');
    expect(r).not.toContain('#0:');
    expect(r).not.toContain('Network error');
  });
  it('a chat with many long user messages keeps the newest quoted and names the rest', () => {
    const many = Array.from({ length: 30 }, (_, i) => user(`msg ${i} ` + 'w'.repeat(1400)));
    const r = structuredRecord(many);
    expect(r).toContain('#29: msg 29');
    expect(r).toContain('#0: msg 0'); // the first one (the task, usually) is always quoted
    expect(r).toMatch(/earlier messages \(#1, #2, /);
    expect(r.length).toBeLessThan(20000);
    // a model that refused a long request: the record shrinks to the room it is given, the newest message still in it
    const small = structuredRecord(many, { maxChars: 6000 });
    expect(small.length).toBeLessThanOrEqual(6000);
    expect(small).toContain('#29: msg 29');
    expect(structuredRecord(many, { maxChars: 6000 })).toBe(small);
  });
});

describe('the compaction style', () => {
  it('roleplays always keep the model summary; unknown values are the default', () => {
    expect(compactStyleOf('structured')).toBe('structured');
    expect(compactStyleOf('both')).toBe('both');
    expect(compactStyleOf('structured', { rp: true })).toBe('summary');
    expect(compactStyleOf('both', { rp: true })).toBe('summary');
    expect(compactStyleOf(undefined)).toBe('summary');
    expect(compactStyleOf('nonsense')).toBe('summary');
  });
});

describe('read_chat "this": the folded part, tool calls included', () => {
  it('stops at the summary and shows arguments and results', () => {
    const msgs = agentChat();
    const t = chatTranscript({ messages: msgs, summary: { text: 'S', upto: 4 } }, { upto: 4, detail: true });
    expect(t).not.toContain('[Summary of the earlier part]');
    expect(t).toContain('[shell cd app && node test.js] FAILED: exit code 1 Error: boom');
    expect(t).toContain('#2 User: Add a test and run it');
    expect(t).not.toContain('#4 User');
  });
});

/** What apiMessages sends for the history, reduced to the parts pruning touches. */
const sent = (messages) => {
  const dead = deadWeight(messages);
  return messages.flatMap((m, mi) => (m.role === 'user' ? [{ u: m.content }] : (m.rounds || []).flatMap((r, ri) => r.calls.flatMap((c, ci) => [{ a: dead.args.get(`${mi}:${ri}:${ci}`) ?? c.arguments }, { t: dead.results.get(`${mi}:${ri}:${ci}`) ?? c.result }]))));
};

describe('dead weight at send time', () => {
  const turn = (q, calls) => [user(q), reply(calls, 'ok')];
  it('keeps only the newest of identical calls (arguments in any key order)', () => {
    const msgs = [...turn('a', [call('read_file', { path: 'x.js', start_line: 1 }, BIG)]), ...turn('b', [call('read_file', { start_line: 1, path: 'x.js' }, BIG + '2')]), ...Array.from({ length: PRUNE_RECENT + 4 }, (_, i) => user('pad ' + i))];
    const d = deadWeight(msgs);
    expect(d.results.get('1:0:0')).toBe(STUB_REPEAT);
    expect(d.results.has('3:0:0')).toBe(false);
  });
  it('stubs a read_file once the file was written or edited later', () => {
    const msgs = [...turn('a', [call('read_file', { path: '/workspace/src/a.js' }, BIG), call('read_file', { path: 'src/b.js' }, BIG)]), ...turn('b', [call('edit_file', { path: 'src/a.js', old_text: 'a', new_text: 'b' }, 'Edited')]), ...Array.from({ length: 10 }, (_, i) => user('pad ' + i))];
    const d = deadWeight(msgs);
    expect(d.results.get('1:0:0')).toMatch(/src\/a\.js was changed later/);
    expect(d.results.has('1:0:1')).toBe(false);
  });
  it('a write that came before the read does not stub it; a short result is left alone', () => {
    const msgs = [...turn('a', [call('write_file', { path: 'a.txt', content: 'x' }, 'Wrote a.txt'), call('read_file', { path: 'a.txt' }, BIG), call('ls', {}, 'short'), call('ls', {}, 'short')]), ...Array.from({ length: 12 }, (_, i) => user('pad ' + i))];
    const d = deadWeight(msgs);
    expect(d.results.size).toBe(0);
  });
  it('clips the big arguments of a failed call after three turns, as valid JSON', () => {
    const fail = call('write_file', { path: 'big.py', content: 'y'.repeat(5000) }, 'Error: disk full', 'error');
    const base = [...turn('a', [fail])];
    const two = [...base, ...turn('b', []), ...turn('c', []), ...Array.from({ length: 8 }, () => reply([]))];
    expect(deadWeight(two, { cut: two.length }).args.size).toBe(0); // two turns later: still in full
    const three = [...base, ...turn('b', []), ...turn('c', []), ...turn('d', []), ...Array.from({ length: 8 }, () => reply([]))];
    const a = deadWeight(three, { cut: three.length }).args.get('1:0:0');
    expect(JSON.parse(a).path).toBe('big.py');
    expect(JSON.parse(a).content).toMatch(/^y{200}… \[4800 chars left out – this call failed\]$/);
    expect(clipArgs('{not json' + 'z'.repeat(900))).toMatch(/^\{"clipped":/);
  });
  it('never touches the newest messages, and roleplay-free calls like ask_user are never stubbed', () => {
    const msgs = [...turn('a', [call('read_file', { path: 'x' }, BIG)]), ...turn('b', [call('read_file', { path: 'x' }, BIG)])];
    expect(pruneCut(msgs.length)).toBe(0);
    expect(deadWeight(msgs).results.size).toBe(0);
    const asks = [...turn('a', [call('ask_user', { question: 'which?' }, 'The user answered: A'.padEnd(300, '.'))]), ...turn('b', [call('ask_user', { question: 'which?' }, 'The user answered: B'.padEnd(300, '.'))]), ...Array.from({ length: 12 }, (_, i) => user('p' + i))];
    expect(deadWeight(asks).results.size).toBe(0);
  });
  it('is stable: two consecutive turns send an identical prefix, even when the new turn repeats an old call', () => {
    const msgs = [];
    for (let i = 0; i < 7; i++) msgs.push(...turn('q' + i, [call('read_file', { path: `f${i % 3}.js` }, BIG + i), call('shell', { command: 'npm test' }, 'exit code 0\n' + BIG)]));
    const cut1 = pruneCut(msgs.length);
    const first = sent(msgs);
    // next turn: the user asks again, the assistant repeats an old read
    const next = [...msgs, ...turn('again', [call('read_file', { path: 'f0.js' }, BIG + 'new')])];
    expect(pruneCut(next.length)).toBe(cut1); // the cut moves in steps of six messages
    const second = sent(next);
    expect(second.slice(0, first.length)).toEqual(first);
    // the same input always gives the same output
    expect(sent(next)).toEqual(second);
    // once the cut moves on, the repeated call's older copies become stubs – one change, then stable again
    const later = [...next, ...turn('x', []), ...turn('y', [])];
    expect(pruneCut(later.length)).toBeGreaterThan(cut1);
    expect(sent(later).filter((x) => x.t === STUB_REPEAT).length).toBeGreaterThan(first.filter((x) => x.t === STUB_REPEAT).length);
    const evenLater = [...later, user('z')];
    expect(sent(evenLater).slice(0, sent(later).length)).toEqual(sent(later));
  });
  it('does not change the stored messages', () => {
    const msgs = [...turn('a', [call('read_file', { path: 'x' }, BIG)]), ...turn('b', [call('read_file', { path: 'x' }, BIG)]), ...Array.from({ length: 12 }, (_, i) => user('p' + i))];
    const before = JSON.stringify(msgs);
    deadWeight(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

describe('the to-do list note', () => {
  it('is only there while a list is open', () => {
    expect(todoNote(null, null)).toBe('');
    expect(todoNote([{ text: 'a', status: 'done' }], null)).toBe('');
    expect(todoNote([{ text: 'a', status: 'done' }, { text: 'b', status: 'pending' }], null)).toMatch(/To-do list:\n- \[x\] a\n- \[ \] b$/);
  });
  it('carries an approved plan being worked on, never a pending or finished one', () => {
    const plan = { status: 'approved', title: 'Refactor', steps: ['split the file', 'add tests'] };
    expect(todoNote([], plan)).toMatch(/Approved plan "Refactor":\n1\. split the file\n2\. add tests/);
    expect(todoNote([], { ...plan, status: 'pending' })).toBe('');
    expect(todoNote([{ text: 'a', status: 'done' }], plan)).toBe(''); // the list says the work is done
  });
  it('a long run carries it every 12 tool rounds, only while the list is open', () => {
    const open = [{ text: 'a', status: 'in_progress' }];
    const rounds = (n) => Array.from({ length: n }, () => ({ calls: [{ name: 'x' }] }));
    expect(TODO_EVERY).toBe(12);
    expect(roundTodoNote(rounds(11), open, null)).toBe('');
    expect(roundTodoNote(rounds(12), open, null)).toMatch(/\[>\] a/);
    expect(roundTodoNote([...rounds(12), { calls: [] }], open, null)).toMatch(/\[>\] a/); // a goal-check round has no calls: not counted
    expect(roundTodoNote(rounds(13), open, null)).toBe('');
    expect(roundTodoNote(rounds(24), open, null)).not.toBe('');
    expect(roundTodoNote(rounds(12), [{ text: 'a', status: 'done' }], null)).toBe('');
    expect(roundTodoNote(rounds(0), open, null)).toBe('');
  });
  it('the key argument of common tools', () => {
    expect(keyArg('shell', '{"command":"ls -la"}')).toBe('ls -la');
    expect(keyArg('apply_patch', JSON.stringify({ patch: '*** Update File: a.js\n*** Move to: b.js' }))).toBe('a.js, b.js');
    expect(keyArg('read_file', 'not json')).toBe('');
  });
});
