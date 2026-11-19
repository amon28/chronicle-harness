// The stylesheet is imported here (the entry), so it is linked in the page <head> and applies before anything
// is shown – if it only came with the lazily loaded app, the unstyled page would flash while that loads.
import './style.css';
// Load settings from IndexedDB before the app module runs (the app reads them synchronously).
import { initSettings } from './store.js';

initSettings()
  .catch(() => {})
  .then(() => import('./main.js'))
  // adb shell am start … --es selftest 1 leaves a one-shot flag: run the bridge self-test once
  .then(() => import('./selftest.js'))
  .then(async (t) => {
    if (!(await t.selfTestRequested())) return;
    const only = globalThis.__ocmSelfTestOnly; // --es only "build:": just those agent scenarios
    if (!only) await t.runBridgeSelfTest();
    await t.runAgentSelfTest(); // scripted agent jobs through the real tools (src/agentsim.js)
    if (!only) await t.runPerfSelfTest(); // every tool, speed, smoothness (src/perfsim.js)
    else await t.selfTestLine?.('perf done', 'skipped (only ' + only + ')');
  })
  .catch(() => {});
