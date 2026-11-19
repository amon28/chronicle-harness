import { zipSync, strToU8 } from 'fflate';
import { test, expect, closeSheets } from './helpers.js';

// a Claude plugin zipped as its folder: 2 skills (one with a script), a command, an http and a stdio MCP server,
// an agent and a hook
const files = {
  'design/.claude-plugin/plugin.json': JSON.stringify({ name: 'design', version: '1.2.0', description: 'Design work', author: { name: 'Anthropic' }, license: 'Apache-2.0' }),
  'design/skills/design-critique/SKILL.md': '---\nname: design-critique\ndescription: Structured design feedback\n---\nLook at hierarchy first.',
  'design/skills/design-critique/scripts/check.sh': '#!/bin/sh\necho ok\n',
  'design/skills/ux-writing/SKILL.md': '---\nname: ux-writing\ndescription: Write UX copy\n---\nShort, clear words.',
  'design/commands/critique.md': '---\ndescription: Critique a design\n---\nCritique this: $ARGUMENTS',
  'design/.mcp.json': JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' }, files: { command: '${CLAUDE_PLUGIN_ROOT}/bin/files' } } }),
  'design/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews designs\n---\nYou review designs.',
  'design/hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'fmt.sh' }] }] } }),
};
const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p, v]) => [p, strToU8(v)]))));

test('import a Claude plugin .zip: preview, install, one group in Skills, switch it off and remove it together', async ({ app }) => {
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.click('#open-askills');
  await app.click('#askill-plugin'); // Skills › 🧩 Claude plugin… opens the Packs sheet
  await expect(app.locator('#packs-sheet')).toHaveClass(/open/);
  await app.setInputFiles('#pk-file', { name: 'design.zip', mimeType: 'application/zip', buffer: zip });
  await expect(app.locator('#pk-title')).toHaveText('🧩 Design 1.2.0');
  await expect(app.locator('#pk-desc')).toContainText('licence: Apache-2.0');
  await expect(app.locator('#pk-items li')).toHaveCount(5); // 2 skills, a snippet, a server, a persona
  await expect(app.locator('#pk-items')).toContainText('Snippet /critique');
  await expect(app.locator('#pk-skipped')).toContainText('hook (PostToolUse)');
  await expect(app.locator('#pk-skipped')).toContainText('MCP server files');
  // the notes carry one of the icon pack's line icons, not a bare serif "ℹ" among them
  await expect(app.locator('#pk-skipped li.hint').first()).toContainText('agent becomes a chat persona');
  await expect(app.locator('#pk-skipped')).not.toContainText('ℹ');
  await expect(app.locator('#pk-skipped li.hint').first().locator('svg.ic')).toHaveCount(1);
  await app.click('#pk-texts summary:has-text("design-critique")'); // the skill's text is readable before installing
  await expect(app.locator('#pk-texts pre').first()).toContainText('Look at hierarchy first.');
  await expect(app.locator('#pk-texts')).toContainText('scripts/check.sh');
  await app.click('#pk-install');
  await expect(app.locator('#pk-list')).toContainText('Claude plugin · Anthropic · 5 items');

  await closeSheets(app);
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="tools"]');
  await app.click('#open-askills');
  const group = app.locator('#askill-list .skill-group');
  await expect(group.locator('summary').first()).toContainText('Design – 2 skills');
  await expect(group.locator('.skill-item')).toHaveCount(2);
  await expect(group).toContainText('design-critique');
  await expect(group).toContainText('ux-writing');
  await group.locator('> summary input[type=checkbox]').uncheck();
  await expect(app.locator('#askill-list .skill-group .skill-item input[type=checkbox]:checked')).toHaveCount(0);
  app.once('dialog', (d) => d.accept());
  await app.click('#askill-list .skill-group button:has-text("Remove Design")');
  await expect(app.locator('#askill-list .skill-group')).toHaveCount(0);
  await closeSheets(app);
  await app.fill('#input', '/criti');
  await expect(app.locator('#slash-menu')).not.toContainText('/critique');
});
