import { test, expect } from './helpers.js';

// DeepSeek's balance on its row in Settings › Custom endpoints (decision 195)
test.use({
  appSettings: {
    providers: [
      { id: 'pvD', name: 'Official Deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds-good', via: 'native', models: 'deepseek-chat', context: 128000, enabled: true },
      { id: 'pvB', name: 'beaver-net', baseUrl: 'https://net.example.org/v1', apiKey: 'k', via: 'native', models: 'm1', context: 32768, enabled: true },
    ],
  },
});

test('the DeepSeek endpoint shows what is left on it; other endpoints show nothing', async ({ app }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  const asked = [];
  await app.route('https://api.deepseek.com/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(r.request().url());
    asked.push(u.pathname + ' ' + (r.request().headers().authorization || ''));
    if (u.pathname === '/user/balance') return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.3456', granted_balance: '2.00', topped_up_balance: '10.3456' }] }) });
    return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [{ id: 'deepseek-chat' }] }) });
  });
  await app.route('https://net.example.org/**', (r) => r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [{ id: 'm1' }] }) }));
  await app.evaluate(() => document.querySelector('#open-settings').click());
  await app.evaluate(() => document.querySelector('#open-providers').click());
  const rows = app.locator('#prov-list .mcp-item');
  await expect(rows.filter({ hasText: 'Official Deepseek' }).locator('.prov-balance')).toHaveText('Balance: $12.35 left ($2.00 of it granted)');
  await expect(rows.filter({ hasText: 'beaver-net' }).locator('.prov-balance')).toHaveCount(0);
  expect(asked).toContain('/user/balance Bearer sk-ds-good'); // asked with the endpoint's own key
});
