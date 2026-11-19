import { test, expect } from './helpers.js';

// A Claude endpoint with an Admin key shows what the account has spent (decision 208), from Anthropic's Usage and
// Cost Analytics API; without one it shows nothing. (A stand-in for api.anthropic.com.)
test.use({
  appSettings: {
    providers: [
      { id: 'pvA', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-api-x', adminKey: 'sk-ant-admin-good', via: 'native', enabled: true },
      { id: 'pvA2', kind: 'anthropic', name: 'Claude, no admin key', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-api-y', via: 'native', enabled: true },
    ],
  },
});

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

test('spend for today, 7 days and the month, by model, asked with the Admin key and the analytics beta', async ({ app }) => {
  const asked = [];
  const now = new Date();
  const dayStart = (back) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back)).toISOString().replace('.000Z', 'Z');
  const row = (back, model, cents) => ({ starting_at: dayStart(back), ending_at: dayStart(back - 1), group: { model }, cost: { currency: 'USD', amount: cents.toFixed(6), list_amount: cents.toFixed(6), requests: 3 } });
  await app.route('https://api.anthropic.com/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(r.request().url());
    const h = r.request().headers();
    if (u.pathname === '/v1/organizations/analytics/cost') {
      asked.push({ key: h['x-api-key'], beta: h['anthropic-beta'], q: u.search });
      // today 1.25 + yesterday 3.00 (opus) + 0.50 (haiku)
      const data = [row(0, 'claude-opus-5-5', 125), row(1, 'claude-opus-5-5', 300), row(1, 'claude-haiku-5-5', 50)];
      return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ data, has_more: false, next_page: null, data_refreshed_at: new Date().toISOString() }) });
    }
    return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: false }) });
  });
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-providers').click());
  const rows = app.locator('#prov-list .mcp-item');
  const withKey = rows.filter({ hasText: 'Anthropic (Claude)' });
  await expect(withKey.locator('.prov-spend')).toContainText('Spent: today $1.25 · 7 days $4.75 · ');
  await expect(withKey.locator('.prov-spend')).toContainText('$4.75 · figures up to');
  await expect(withKey.locator('.prov-spend')).toContainText('(before credits)');
  await expect(withKey.locator('.prov-spend-models')).toHaveText('This month: opus-5-5 $4.25 · haiku-5-5 $0.50');
  await expect(rows.filter({ hasText: 'no admin key' }).locator('.prov-spend')).toHaveCount(0);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked[0].key).toBe('sk-ant-admin-good'); // the Admin key, not the ordinary one
  expect(asked[0].beta).toBe('analytics-usage-cost-2026-08-24');
  expect(decodeURIComponent(asked[0].q)).toContain('time_bucket_width=1d');
  expect(decodeURIComponent(asked[0].q)).toContain('group_by[]=model');
});

test('a wrong Admin key is said plainly', async ({ app }) => {
  await app.route('https://api.anthropic.com/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (new URL(r.request().url()).pathname.startsWith('/v1/organizations/')) return r.fulfill({ status: 401, contentType: 'application/json', headers: cors, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [], has_more: false }) });
  });
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-providers').click());
  await expect(app.locator('#prov-list .mcp-item', { hasText: 'Anthropic (Claude)' }).locator('.prov-spend')).toContainText('it must be an Admin API key (sk-ant-admin…)');
});

test('the Admin key field is on the Claude endpoint editor only', async ({ app }) => {
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-providers').click());
  await app.locator('#prov-list .mcp-item', { hasText: 'no admin key' }).locator('.act', { hasText: 'Edit' }).click();
  await expect(app.locator('#pv-admin')).toBeVisible();
  await app.click('#pv-back');
  await app.click('#prov-add-custom');
  await expect(app.locator('#pv-admin')).toBeHidden();
});
