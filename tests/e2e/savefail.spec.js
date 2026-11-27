import { test, expect, send } from './helpers.js';

// Decision 256: a chat save whose transaction aborts (storage full aborts at commit, firing only "abort") is said, not
// left hanging with nothing on screen.
test('a chat save that the database aborts is said', async ({ app }) => {
  await app.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      const r = put.apply(this, a);
      if (this.name === 'conversations') this.transaction.abort();
      return r;
    };
  });
  await send(app, 'hello there');
  await expect(app.locator('#toast')).toContainText('Could not save your changes', { timeout: 10000 });
});

// Decision 256: a double tap on send while the message is still being got ready sends it once.
test('a double tap on send sends the message once', async ({ app }) => {
  // with a file attached: send() first loads the chat's folder from the database – the moment a second tap got in
  await app.setInputFiles('#file-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('some notes') });
  await expect(app.locator('#attachments')).toContainText('notes.txt');
  await app.fill('#input', 'only once please');
  await app.evaluate(() => {
    const b = document.querySelector('#send-btn');
    b.click();
    b.click();
  });
  await app.waitForFunction(() => !document.body.classList.contains('streaming') && document.querySelector('.msg.assistant .msg-actions'), null, { timeout: 20000 });
  await app.waitForTimeout(500);
  await expect(app.locator('.msg.user')).toHaveCount(1);
});
