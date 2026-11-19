import { test, expect, send } from './helpers.js';

const skill = { id: 'sk2_t', name: 'meeting-notes', description: 'Notes from meetings. Use after a meeting.', instructions: 'Write decisions first, then actions.', files: {}, enabled: true, createdAt: 1, updatedAt: 1 };
test.use({ appSettings: { prefs: { tools: false }, agentSkills: [skill] } });

test.describe('with tools on', () => {
test.use({ appSettings: { prefs: { tools: true }, agentSkills: [skill] } });
test('the assistant sees installed skills and can load one with use_skill', async ({ app, request }) => {
  await send(app, 'USESKILL summarize the meeting');
  await expect(app.locator('.tool-card', { hasText: 'Used skill' })).toBeVisible();
  const reqs = (await (await request.get(`${globalThis.__MOCK}/__requests`)).json()).filter((r) => r.messages);
  expect(reqs[0].messages[0].content).toContain('meeting-notes: Notes from meetings');
  expect(JSON.stringify(reqs.at(-1).messages)).toContain('Write decisions first, then actions.'); // the skill text went back to the model
});
});

test('Skills screen: create, edit, import and delete', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.click('#open-askills');
  await expect(app.locator('#askill-list .skill-item')).toHaveCount(4); // the built-in mods guide, harness guide and playbook + the seeded one
  await app.click('#askill-new');
  await app.fill('#askill-name', 'Weekly Report');
  await app.fill('#askill-desc', 'Weekly status. Use on Fridays.');
  await app.fill('#askill-ins', '1. Gather\n2. Write');
  await app.click('#askill-create');
  await expect(app.locator('#askill-list .skill-item')).toHaveCount(5);
  await expect(app.locator('#askill-list')).toContainText('weekly-report');
  await app.setInputFiles('#askill-file', { name: 'tidy.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await app.setInputFiles('#askill-file', { name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: pdf-forms\ndescription: Fill PDF forms\n---\nDo the thing') });
  await expect(app.locator('#askill-list')).toContainText('pdf-forms');
  const item = app.locator('#askill-list .skill-item', { hasText: 'weekly-report' });
  await item.locator('summary').click();
  await item.locator('input.field').fill('Weekly status, updated.');
  await item.locator('button:has-text("Save")').click();
  await expect(app.locator('#askill-list')).toContainText('Weekly status, updated.');
  app.once('dialog', (d) => d.accept());
  await app.locator('#askill-list .skill-item', { hasText: 'weekly-report' }).locator('summary').click();
  await app.locator('#askill-list .skill-item', { hasText: 'weekly-report' }).locator('button:has-text("Delete")').click();
  await expect(app.locator('#askill-list .skill-item')).toHaveCount(5);
});

test('the Skill Creator persona starts a chat with tools on', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.click('#open-askills');
  await app.click('#askill-make');
  await expect(app.locator('#persona-name-btn')).toContainText('Skill Creator');
  await expect(app.locator('#tools-btn')).toHaveText(/\d+ tools/); // tools are on for this persona although they're off by default
});
