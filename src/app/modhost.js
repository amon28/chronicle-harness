// The one ModHost of the app (see src/mods.js). Kept apart so the engine and the message box can use it
// without importing the Settings screens.
import { ModHost } from '../mods.js';
import { saveSettings } from '../store.js';
import { hooks, state, toast } from './core.js';

export const modHost = new ModHost({
  getSettings: () => state.settings,
  save: () => saveSettings(state.settings),
  toast: (t) => toast(t, 4000),
  onChange: () => hooks.modsChanged?.(),
});
