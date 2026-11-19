import { test, expect } from './helpers.js';

test.describe('quick-reply bar', () => {
  test.use({ appSettings: { snippetsV: 3, snippets: [{ id: 'q1', cmd: 'nod', title: 'Nod', text: '*nods*', send: true, bar: 'all' }, { id: 'q2', cmd: 'why', title: 'Ask why', text: 'Why {{text}}?', bar: 'chat' }, { id: 'q3', cmd: 'scene', title: 'Scene', text: 'x', bar: 'rp' }] } });
  test('buttons above the box send or fill in a snippet', async ({ app }) => {
    const bar = app.locator('#quick-bar');
    await expect(bar.locator('button')).toHaveText(['Nod', 'Ask why']); // the roleplay-only one is not shown in chats
    await app.fill('#input', 'the sky is blue');
    await bar.locator('button', { hasText: 'Ask why' }).click();
    await expect(app.locator('#input')).toHaveValue('Why the sky is blue?');
    await app.fill('#input', '');
    await bar.locator('button', { hasText: 'Nod' }).click();
    await expect(app.locator('.msg.user').last()).toContainText('nods');
  });
});
