import { test, MOCK } from './helpers.js';
import { BUILTIN_PERSONAS } from '../../src/personas.js';

// The README's pictures of the app (docs/screenshots/), made from the real app with made-up chats. Not part of the
// normal run: `SCREENSHOTS=1 npx playwright test tests/e2e/screenshots.spec.js`.
test.skip(!process.env.SCREENSHOTS, 'only when making the README pictures (SCREENSHOTS=1)');

const svg = (bg, glyph) =>
  'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><text x="128" y="160" font-size="120" text-anchor="middle" fill="white" font-family="sans-serif">${glyph}</text></svg>`).toString('base64');
const MIRA = { id: 'p_mira', name: 'Mira', rp: true, cardMode: true, prompt: 'You are Mira.', avatar: { image: svg(['#7c3aed', '#db2777'], 'M') }, card: { name: 'Mira', description: 'A tall archivist with ink-stained fingers who guards the old library.', personality: 'dry, patient, curious', scenario: 'The library at closing time.', first_mes: '*looks up from the ledger* We are closed.' } };
const T = Date.now();
const at = (min) => T - min * 60000;

const CHAT = {
  id: 'shot_chat',
  title: 'Planning a trip to Kyoto',
  personaId: 'general',
  createdAt: at(30),
  updatedAt: at(2),
  messages: [
    { role: 'user', content: 'I have 3 days in Kyoto in spring. What should I not miss, and how should I split the days?', at: at(4) },
    {
      role: 'assistant',
      at: at(3),
      model: 'glm-5.3',
      content:
        "Spring is a lovely time – the cherry blossoms usually peak in **early April**. Here's a relaxed plan that keeps travel between sights short:\n\n### Day 1 – Eastern Kyoto\n- **Kiyomizu-dera** early, before the crowds\n- Walk down **Sannenzaka** and **Ninenzaka**\n- **Philosopher's Path** in the afternoon (best for blossoms)\n\n### Day 2 – Arashiyama\n- **Bamboo grove** at sunrise\n- **Tenryū-ji** garden, then a boat on the Hozu river\n\n### Day 3 – Fushimi & the centre\n- **Fushimi Inari** – go past the first gates, it gets quiet\n- **Nishiki Market** for lunch\n\n| Day | Area | Walking |\n| --- | --- | --- |\n| 1 | Higashiyama | ~8 km |\n| 2 | Arashiyama | ~6 km |\n| 3 | Fushimi / centre | ~9 km |\n\nWant me to add restaurants or a rainy-day backup?",
    },
  ],
};

const call = (name, args, result, display = {}) => ({ id: 'c_' + name + Math.random().toString(36).slice(2, 6), name, arguments: JSON.stringify(args), result, status: 'done', display });
const AGENT = {
  id: 'shot_agent',
  title: 'Sales chart from the CSV',
  personaId: 'coder',
  createdAt: at(60),
  updatedAt: at(1),
  tools: true,
  messages: [
    { role: 'user', content: 'Here is sales.csv – make a chart of revenue per month and tell me which month was best.', at: at(6) },
    {
      role: 'assistant',
      at: at(5),
      model: 'kimi-k3',
      rounds: [
        { content: "I'll read the file first.", calls: [call('read_file', { path: 'sales.csv' }, 'month,revenue\nJan,12400\nFeb,13950\nMar,18210\n…', { path: 'sales.csv' })] },
        { content: '', calls: [call('run_python', { code: "import pandas as pd\nimport matplotlib.pyplot as plt\ndf = pd.read_csv('sales.csv')\ndf.plot(x='month', y='revenue', kind='bar')\nplt.savefig('output/revenue.png')\nprint(df.loc[df.revenue.idxmax()])" }, 'month      Mar\nrevenue  18210', { output: 'month      Mar\nrevenue  18210' })] },
        { content: '', calls: [call('write_file', { path: 'output/summary.md', content: '# Revenue\nBest month: March (18,210).' }, 'Wrote output/summary.md', { path: 'output/summary.md' })] },
      ],
      content: '**March was the best month** with 18,210 in revenue – 31% more than February. The chart is in `output/revenue.png` and a short summary in `output/summary.md`.',
    },
  ],
};

const RP = {
  id: 'shot_rp',
  title: 'The library at closing time',
  createdAt: at(120),
  updatedAt: at(8),
  personaId: 'p_mira',
  messages: [
    { role: 'assistant', personaId: 'p_mira', at: at(20), content: '*looks up from the ledger, pen still in hand* "We are closed. The lamps go out in ten minutes."' },
    { role: 'user', at: at(15), content: '*holds up a soaked, torn map* "Please – I only need to find where this river used to run."' },
    {
      role: 'assistant',
      personaId: 'p_mira',
      at: at(10),
      model: 'deepseek-v4.1-flash',
      content: '*Mira sets the pen down and studies the map for a long moment, then sighs.* "Rivers do not move, traveller. People just forget them."\n\n*She takes a lamp from the desk and walks toward the back shelves, waving for you to follow.* "The old survey books are down here. **Ten minutes.** Not a second more."',
    },
  ],
};

const OTHERS = [
  ['Fix the login bug in the API', 40],
  ['Explain transformers simply', 180],
  ['Weekly meal plan', 600],
  ['Draft a reply to the landlord', 1500],
].map(([title, m], i) => ({ id: 'shot_o' + i, title, personaId: ['coder', 'tutor', 'general', 'general'][i], createdAt: at(m + 5), updatedAt: at(m), messages: [{ role: 'user', content: title, at: at(m) }] }));

test.use({ colorScheme: 'dark', deviceScaleFactor: 2, appSettings: { personas: [...BUILTIN_PERSONAS.map((p) => ({ ...p, builtin: true })), MIRA], defaultPersonaId: 'general', prefs: { tools: true, autoTitle: false, learn: false } } });

const seed = (app, convs) =>
  app.evaluate(
    (convs) =>
      new Promise((resolve) => {
        const q = indexedDB.open('chronicle');
        q.onsuccess = () => {
          const t = q.result.transaction('conversations', 'readwrite');
          convs.forEach((c) => t.objectStore('conversations').put(c));
          t.oncomplete = resolve;
        };
      }),
    convs,
  );
const DIR = 'docs/screenshots/';
const settle = (app) => app.waitForTimeout(700);
const openChat = async (app, title, mode = 'chat') => {
  const drawerOpen = await app.evaluate(() => document.querySelector('.mode-tab').getBoundingClientRect().left >= 0);
  if (!drawerOpen) {
    await app.click('#menu-btn');
    await settle(app);
  }
  await app.click(`.mode-tab[data-mode="${mode}"]`);
  await app.click(`.conv-item:has-text("${title}")`);
  await settle(app);
  await app.evaluate(() => document.querySelectorAll('.messages, #messages').forEach((m) => (m.scrollTop = 0)));
  await settle(app);
};

test('README pictures', async ({ app }) => {
  await app.addInitScript((u) => (globalThis.__ocmUsageUrl = u), MOCK + '/usage');
  await seed(app, [CHAT, AGENT, RP, ...OTHERS]);
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');

  await openChat(app, CHAT.title);
  await app.screenshot({ path: DIR + 'chat.png' });

  await openChat(app, AGENT.title);
  await app.evaluate(() => {
    document.querySelector('.msg.assistant .tool-group')?.setAttribute('open', '');
    document.querySelectorAll('.msg.assistant .tool-card')[1]?.setAttribute('open', '');
  });
  await settle(app);
  await app.screenshot({ path: DIR + 'agent.png' });

  await app.click('#menu-btn');
  await settle(app);
  await app.screenshot({ path: DIR + 'chats.png' });

  await openChat(app, RP.title, 'rp');
  await app.screenshot({ path: DIR + 'roleplay.png' });

  await openChat(app, CHAT.title, 'chat');
  await app.click('#model-btn');
  await settle(app);
  await app.screenshot({ path: DIR + 'models.png' });
  await app.keyboard.press('Escape');
  await settle(app);

  await app.evaluate(() => document.querySelector('#open-settings').click());
  await settle(app);
  await app.screenshot({ path: DIR + 'settings.png' });
});
