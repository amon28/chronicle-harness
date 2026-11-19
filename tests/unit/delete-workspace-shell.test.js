// "Delete all files" and "Delete chat" must also delete the copy the shell holds: a real directory under the app's
// files (shell/work/<chat>, and shell/phone/<chat> for a mirrored phone folder). Left behind, the files come back
// into the chat with the next shell command, and a deleted chat's files stay on the phone for ever.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeFs } from './helpers/fakefs.js';
import { syncWork } from '../../src/bridge.js';
import * as shellfs from '../../src/shellfs.js';
import { getWorkspace, deleteWorkspace, wsPut } from '../../src/sandbox.js';

let fs;
beforeEach(() => {
  fs = fakeFs();
  globalThis.__ocmFiles = fs;
  delete globalThis.__ocmMode;
});
const under = (dir) => [...fs.files.keys()].filter((p) => p.startsWith('/data/' + dir));

describe('deleting a workspace', () => {
  it('removes the shell copy, so the next command does not bring the deleted files back', async () => {
    const w = await getWorkspace('del1');
    wsPut(w, 'secret.key', 'AES KEY');
    wsPut(w, 'notes/a.txt', 'a');
    await syncWork(w, 'del1');
    await shellfs.writeFile('phone/del1', 'from-the-phone.txt', new TextEncoder().encode('copied in for /phone'));
    expect(under('shell/work/del1').length).toBe(2);

    await deleteWorkspace('del1');
    expect(under('shell/work/del1')).toEqual([]);
    expect(under('shell/phone/del1')).toEqual([]);

    // the same chat again (Delete all files keeps the chat): its next shell command starts from nothing
    const again = await getWorkspace('del1');
    await syncWork(again, 'del1');
    expect(Object.keys(again.files)).toEqual([]);
  });

  it('leaves other chats alone, also one whose id starts the same', async () => {
    const a = await getWorkspace('chat');
    const b = await getWorkspace('chat-2');
    wsPut(a, 'a.txt', 'a');
    wsPut(b, 'b.txt', 'b');
    await syncWork(a, 'chat');
    await syncWork(b, 'chat-2');
    await deleteWorkspace('chat');
    expect(under('shell/work/chat-2').length).toBe(1);
  });
});
