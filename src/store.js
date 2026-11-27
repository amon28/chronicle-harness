// Tiny IndexedDB wrapper for conversations + localStorage for settings.
import { callSite, noteSite } from './perf.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
const DB_NAME = 'chronicle';
const STORE = 'conversations';
const WS_STORE = 'workspaces';
// a chat's files, one record each, keyed [convId, path] (decision 259): the workspace record keeps the rest. A chat's
// workspace was one record with every file's bytes, written whole after every change.
const FILE_STORE = 'wsfiles';
// a chat's messages, a record of their own keyed by the chat's id (decision 260): the chat's record keeps the rest
// (title, times, settings), so the list can be read at start without every message of every chat
const MSG_STORE = 'messages';
const CK = '\u0000ck'; // the workspace record's checkpoints (the undo copies of the files) are a record of their own: id + CK
const KV_STORE = 'kv'; // settings (personas, cards, lorebooks, memories…) – far more room than localStorage // per-chat sandbox files: { id: convId, files: { [path]: { data: Uint8Array, mtime } } }

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 5);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(WS_STORE)) d.createObjectStore(WS_STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(KV_STORE)) d.createObjectStore(KV_STORE);
        if (!d.objectStoreNames.contains(FILE_STORE)) d.createObjectStore(FILE_STORE);
        if (!d.objectStoreNames.contains(MSG_STORE)) d.createObjectStore(MSG_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).then((d) => fromOldName(d).then(() => d));
  }
  return dbPromise;
}

/**
 * The database was called "opencode-mobile" before the app was renamed (decision 217). An install that has it (the
 * app updated in place) gets everything copied into "chronicle" once, record by record, before anything reads it;
 * the old one is left as it was (nothing is lost if this is cut short – it runs again until it has finished).
 */
export const OLD_DB_NAME = 'opencode-mobile';
const MIGRATED = '__copiedFromOldName';
const req2p = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
async function fromOldName(d) {
  try {
    if (!indexedDB.databases) return;
    if (!(await indexedDB.databases()).some((x) => x.name === OLD_DB_NAME)) return;
    if (await req2p(d.transaction(KV_STORE).objectStore(KV_STORE).get(MIGRATED))) return;
    const old = await req2p(indexedDB.open(OLD_DB_NAME));
    try {
      for (const name of [STORE, WS_STORE, KV_STORE]) {
        if (!old.objectStoreNames.contains(name)) continue;
        const keys = await req2p(old.transaction(name).objectStore(name).getAllKeys());
        for (const k of keys) {
          const v = await req2p(old.transaction(name).objectStore(name).get(k));
          if (v === undefined) continue;
          await new Promise((res, rej) => {
            const t = d.transaction(name, 'readwrite');
            if (name === KV_STORE) t.objectStore(name).put(v, k);
            else t.objectStore(name).put(v);
            t.oncomplete = res;
            t.onerror = () => rej(t.error);
          });
        }
      }
    } finally {
      old.close();
    }
    await new Promise((res, rej) => {
      const t = d.transaction(KV_STORE, 'readwrite');
      t.objectStore(KV_STORE).put(Date.now(), MIGRATED);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  } catch (e) {
    console.warn('Copying the data from the old database failed:', e?.message || e);
  }
}

function tx(mode, fn, store = STORE) {
  const site = callSite(3); // 🩺: who asked, for a slow frame after it (decision 247)
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => {
          if (site) noteSite('database', `${mode} ${store} ← ${site}`);
          resolve(req?.result);
        };
        t.onerror = () => reject(t.error);
        // storage full and the like abort the transaction at commit, which fires only "abort": without this the save
        // never settled and nothing said it failed (decision 256)
        t.onabort = () => reject(t.error || new Error('The save was aborted (is the phone out of storage?)'));
      }),
  );
}

// IndexedDB copies what it stores by itself, so a JSON copy first only doubles the work for a long chat; it is the
// fallback for the rare value IndexedDB can't copy (a function, a DOM node), which JSON quietly drops (decision 239)
const putPlain = (put, v) => put(v).catch((e) => (e?.name === 'DataCloneError' ? put(JSON.parse(JSON.stringify(v))) : Promise.reject(e)));

/** One transaction over the chats' records and their messages. */
function convTx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((res, rej) => {
        const t = d.transaction([STORE, MSG_STORE], mode);
        const out = fn(t.objectStore(STORE), t.objectStore(MSG_STORE));
        t.oncomplete = () => res(typeof out === 'function' ? out() : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('The save was aborted (is the phone out of storage?)'));
      }),
  );
}
/** Does this chat object carry its messages? (one whose messages are not loaded yet has none of its own, decision 260) */
const hasMessages = (c) => Object.prototype.propertyIsEnumerable.call(c, 'messages') && Array.isArray(c.messages);
function convMeta(c) {
  const out = {};
  for (const k of Object.keys(c)) if (k !== 'messages') out[k] = c[k];
  out.split = 1;
  return out;
}
/**
 * Chats: { id, title, …, messages } to the app; in the database the chat's record and its messages apart (decision 260).
 * A chat saved by an earlier version (messages in its record) is read as it is and saved apart from then on. A chat
 * whose messages are not loaded yet is saved without them: its stored messages stay as they are.
 */
export const conversations = {
  /** Every chat with its messages (a backup, an export). */
  all: () =>
    convTx('readonly', (cs, ms) => {
      const recs = cs.getAll();
      const keys = ms.getAllKeys();
      const vals = ms.getAll();
      return () => {
        const byId = new Map((keys.result || []).map((k, i) => [k, vals.result[i]]));
        return (recs.result || [])
          .map((r) => {
            if (!r.split) return r;
            const { split: _s, ...c } = r;
            return { ...c, messages: byId.get(r.id) || [] };
          })
          .sort((a, b) => b.updatedAt - a.updatedAt);
      };
    }),
  /** The chats' records without their messages (those saved apart) – what the app reads at start. */
  heads: () => tx('readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => b.updatedAt - a.updatedAt)),
  /** One chat's messages (saved apart), or null. */
  messagesOf: (id) => tx('readonly', (s) => s.get(id), MSG_STORE).then((m) => m || null),
  // a failed chat save is said like a failed settings save (decision 256), and still rejects for the caller
  put: (c) =>
    putPlain(
      (v) =>
        convTx('readwrite', (cs, ms) => {
          cs.put(convMeta(v));
          if (hasMessages(v)) ms.put(v.messages, v.id);
        }),
      c,
    ).catch((e) => (onSaveError?.(e), Promise.reject(e))),
  remove: (id) =>
    convTx('readwrite', (cs, ms) => {
      cs.delete(id);
      ms.delete(id);
    }),
  clear: () =>
    convTx('readwrite', (cs, ms) => {
      cs.clear();
      ms.clear();
    }),
};

/** One transaction over the workspace records and their files. fn(ws, files) → what to resolve with (read at the end). */
function wsTx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((res, rej) => {
        const t = d.transaction([WS_STORE, FILE_STORE], mode);
        const out = fn(t.objectStore(WS_STORE), t.objectStore(FILE_STORE));
        t.oncomplete = () => res(typeof out === 'function' ? out() : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('The save was aborted (is the phone out of storage?)'));
      }),
  );
}
const filesOf = (id) => IDBKeyRange.bound([id], [id, []]); // every [id, path]: a path is a string, [] sorts after them all
/** The workspace record without its files and checkpoints (they are records of their own). */
function wsMeta(w) {
  const { files: _f, checkpoints: _c, ...rest } = w;
  return { ...rest, split: 1 };
}
const plainFile = (f) => (f && Object.getPrototypeOf(f) !== Object.prototype && Object.getPrototypeOf(f) !== null ? { ...f } : f);
/**
 * Workspaces: { id, files: { [path]: { data, mtime, … } }, checkpoints, …rest } to the app; in the database the record
 * (rest), each file, and the checkpoints apart (decision 259). A record saved whole by an earlier version is read as it
 * is, and saved apart from then on.
 */
export const workspaces = {
  all: async () => {
    const out = [];
    for (const id of await workspaces.ids()) {
      const w = await workspaces.get(id);
      if (w) out.push(w);
    }
    return out;
  },
  ids: () => tx('readonly', (s) => s.getAllKeys(), WS_STORE).then((l) => (l || []).filter((k) => !String(k).endsWith(CK))),
  get: (id) =>
    wsTx('readonly', (ws, fs) => {
      const m = ws.get(id);
      const ck = ws.get(id + CK);
      let vals = null;
      let keys = null;
      m.onsuccess = () => {
        if (!m.result?.split) return;
        vals = fs.getAll(filesOf(id));
        keys = fs.getAllKeys(filesOf(id));
      };
      return () => {
        const rec = m.result;
        if (!rec || !rec.split) return rec;
        const files = {};
        (keys?.result || []).forEach((k, i) => (files[k[1]] = vals.result[i]));
        const w = { ...rec, files };
        delete w.split;
        if (ck.result?.list) w.checkpoints = ck.result.list;
        Object.defineProperty(w, 'stored', { value: 'split', enumerable: false, configurable: true });
        return w;
      };
    }),
  /** The whole workspace: its record, every file (the ones it no longer has removed) and its checkpoints. */
  put: (w) =>
    wsTx('readwrite', (ws, fs) => {
      fs.delete(filesOf(w.id));
      for (const [p, f] of Object.entries(w.files || {})) fs.put(plainFile(f), [w.id, p]);
      ws.put(wsMeta(w));
      if (w.checkpoints?.length) ws.put({ id: w.id + CK, list: w.checkpoints });
      else ws.delete(w.id + CK);
    }).catch((e) => (onSaveError?.(e), Promise.reject(e))),
  /** Only what changed: these files written, those removed, the record, and the checkpoints when `ck`. */
  putChanged: (w, { put = [], del = [], ck = false } = {}) =>
    wsTx('readwrite', (ws, fs) => {
      for (const p of del) fs.delete([w.id, p]);
      for (const p of put) if (w.files[p]) fs.put(plainFile(w.files[p]), [w.id, p]);
      ws.put(wsMeta(w));
      if (ck) {
        if (w.checkpoints?.length) ws.put({ id: w.id + CK, list: w.checkpoints });
        else ws.delete(w.id + CK);
      }
    }).catch((e) => (onSaveError?.(e), Promise.reject(e))),
  remove: (id) =>
    wsTx('readwrite', (ws, fs) => {
      ws.delete(id);
      ws.delete(id + CK);
      fs.delete(filesOf(id));
    }),
  clear: () =>
    wsTx('readwrite', (ws, fs) => {
      ws.clear();
      fs.clear();
    }),
};

const SETTINGS_KEY = 'ocm.settings';
const defaults = { apiKey: '', proxyUrl: '', workspaceId: '', systemPrompt: '', model: '', effort: {} };
let settingsCache = null;
let onSaveError = null;
export const setSaveErrorHandler = (fn) => (onSaveError = fn);

const kvGet = (key) => db().then((d) => new Promise((res, rej) => {
  const r = d.transaction(KV_STORE).objectStore(KV_STORE).get(key);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const kvPut = (key, value) => db().then((d) => new Promise((res, rej) => {
  const t = d.transaction(KV_STORE, 'readwrite');
  t.objectStore(KV_STORE).put(value, key);
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('Write aborted'));
}));

// ---------- secrets (Android Keystore) ----------
// API keys and tokens are kept out of IndexedDB on Android: they're encrypted with a key in the
// Android Keystore by the native SecureStore plugin. The web build keeps them with the settings.
const SecureStore = Capacitor.isNativePlatform() ? registerPlugin('SecureStore') : null;
const TOP_SECRETS = ['apiKey', 'exaKey', 'ghToken', 'microlinkKey', 'githubToken', 'githubRefresh', 'githubSshKey'];
let secretsJson = null; // last written blob, to skip needless writes
let secureOk = !!SecureStore;
let onSecretsLost = null;
export const setSecretsLostHandler = (fn) => (onSecretsLost = fn);
export const secureStorageActive = () => secureOk;

/** Split settings into { secrets, clean } – clean has every key/token blanked. */
export function splitSecrets(s) {
  const secrets = { providers: {}, providerAdmin: {}, mcp: {}, pc: {}, mcpOauth: {}, mcpBridge: {}, acp: {} };
  const clean = { ...s };
  for (const k of TOP_SECRETS) {
    if (s[k]) secrets[k] = s[k];
    clean[k] = '';
  }
  clean.providers = (s.providers || []).map((p) => {
    if (p.apiKey) secrets.providers[p.id] = p.apiKey;
    if (p.adminKey) secrets.providerAdmin[p.id] = p.adminKey; // Anthropic Admin key, for spend (decision 208)
    return { ...p, apiKey: '', adminKey: '' };
  });
  clean.mcpServers = (s.mcpServers || []).map((m) => {
    if (m.token) secrets.mcp[m.id] = m.token;
    const c = { ...m, token: '' };
    // the sign-in's access + refresh tokens and a phone-run server's bridge secret are keys too (decision 256)
    if (m.oauth && (m.oauth.access || m.oauth.refresh)) {
      secrets.mcpOauth[m.id] = { access: m.oauth.access || '', refresh: m.oauth.refresh || '' };
      c.oauth = { ...m.oauth, access: '', refresh: '' };
    }
    if (m.bridgeSecret) {
      secrets.mcpBridge[m.id] = m.bridgeSecret;
      c.bridgeSecret = '';
    }
    return c;
  });
  // a PC agent's bridge secret (decision 256)
  clean.acpAgents = (s.acpAgents || []).map((a) => {
    if (a.secret) secrets.acp[a.id] = a.secret;
    return a.secret ? { ...a, secret: '' } : a;
  });
  if (!s.acpAgents) delete clean.acpAgents;
  // Files on my PC (decision 223): the secret pc-files.py printed
  clean.pcFiles = (s.pcFiles || []).map((p) => {
    if (p.secret) secrets.pc[p.id] = p.secret;
    return { ...p, secret: '' };
  });
  return { secrets, clean };
}
/** Any key still in the plain settings (from before secure storage, or a kind of key added to it later). */
export function hasPlainSecrets(s) {
  const { secrets } = splitSecrets(s);
  return Object.values(secrets).some((v) => (typeof v === 'string' ? v : Object.keys(v).length));
}
export function mergeSecrets(s, sec) {
  if (!sec) return s;
  for (const k of TOP_SECRETS) if (sec[k] && !s[k]) s[k] = sec[k];
  for (const p of s.providers || []) {
    if (!p.apiKey && sec.providers?.[p.id]) p.apiKey = sec.providers[p.id];
    if (!p.adminKey && sec.providerAdmin?.[p.id]) p.adminKey = sec.providerAdmin[p.id];
  }
  for (const m of s.mcpServers || []) {
    if (!m.token && sec.mcp?.[m.id]) m.token = sec.mcp[m.id];
    const o = sec.mcpOauth?.[m.id];
    if (o && m.oauth && !m.oauth.access && !m.oauth.refresh) m.oauth = { ...m.oauth, access: o.access, refresh: o.refresh };
    if (!m.bridgeSecret && sec.mcpBridge?.[m.id]) m.bridgeSecret = sec.mcpBridge[m.id];
  }
  for (const a of s.acpAgents || []) if (!a.secret && sec.acp?.[a.id]) a.secret = sec.acp[a.id];
  for (const p of s.pcFiles || []) if (!p.secret && sec.pc?.[p.id]) p.secret = sec.pc[p.id];
  return s;
}
async function readSecrets() {
  if (!secureOk) return null;
  try {
    const r = await SecureStore.get({ name: 'secrets' });
    secretsJson = r?.value ?? null;
    return r?.value ? JSON.parse(r.value) : null;
  } catch (e) {
    if (/DECRYPT/i.test(e?.code || e?.message || '')) setTimeout(() => onSecretsLost?.(e), 0);
    else secureOk = false; // plugin missing (old native build) → keep keys with the settings
    return null;
  }
}

/**
 * Load settings into memory before the app starts. Settings used to live in localStorage (~5 MB, and
 * writes failed silently when full); they're moved to IndexedDB once.
 */
export async function initSettings() {
  let s = null;
  try {
    s = await kvGet('settings');
  } catch {
    /* IndexedDB unavailable → fall back below */
  }
  if (!s) {
    try {
      s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    } catch {
      s = null;
    }
    if (s) {
      try {
        await kvPut('settings', s);
        localStorage.removeItem(SETTINGS_KEY); // free the space; IndexedDB is the source of truth now
        localStorage.setItem('ocm.settingsInIdb', '1');
      } catch {
        /* keep using localStorage copy */
      }
    }
  }
  settingsCache = { ...defaults, ...(s || {}) };
  const sec = await readSecrets();
  mergeSecrets(settingsCache, sec);
  // first run with secure storage: move any plain-text keys out of IndexedDB
  if (secureOk && s && hasPlainSecrets(s)) {
    saveSettings(settingsCache);
  }
  try {
    navigator.storage?.persist?.(); // ask the browser not to evict our data
  } catch {
    /* ignore */
  }
  return settingsCache;
}

export function loadSettings() {
  if (settingsCache) return settingsCache;
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

// Writes are serialized; a burst of saves only writes the latest state.
let saving = null;
let pendingSave = null;
export function saveSettings(s) {
  settingsCache = s;
  pendingSave = s;
  if (saving) return saving;
  saving = (async () => {
    while (pendingSave) {
      const snap = pendingSave;
      pendingSave = null;
      try {
        let toStore = snap;
        if (secureOk) {
          const { secrets, clean } = splitSecrets(snap);
          const json = JSON.stringify(secrets);
          try {
            if (json !== secretsJson) {
              await SecureStore.set({ name: 'secrets', value: json });
              secretsJson = json;
            }
            toStore = clean;
          } catch {
            secureOk = false; // couldn't encrypt → keep the keys with the settings rather than lose them
          }
        }
        await putPlain((v) => kvPut('settings', v), toStore);
      } catch (e) {
        onSaveError?.(e);
      }
    }
    saving = null;
  })();
  return saving;
}

export function cache(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('ocm.cache.' + key) || 'null');
    localStorage.setItem('ocm.cache.' + key, JSON.stringify(value));
  } catch {
    return null;
  }
}

// Full-size character art, kept apart from settings so saving settings stays fast.
const artMem = new Map();
/** Art ids and one picture at a time, without the in-memory cache (for backups of a lot of data). */
const artKeys = () => db().then((d) => new Promise((res, rej) => {
  const r = d.transaction(KV_STORE).objectStore(KV_STORE).getAllKeys();
  r.onsuccess = () => res((r.result || []).map(String).filter((k) => k.startsWith('art:')).map((k) => k.slice(4)));
  r.onerror = () => rej(r.error);
}));
/** A chat's git repository data (git.js), kept beside its workspace. */
/** A chat's git history and search index by raw key ("git:<id>", "vec:<id>"), for "Export everything" (decision 218). */
export const kvMove = {
  keys: () => db().then((d) => new Promise((res, rej) => {
    const r = d.transaction(KV_STORE).objectStore(KV_STORE).getAllKeys();
    r.onsuccess = () => res((r.result || []).map(String).filter((k) => /^(git|vec):/.test(k)));
    r.onerror = () => rej(r.error);
  })),
  get: (k) => kvGet(k),
  put: (k, v) => (/^(git|vec):/.test(k) ? kvPut(k, v) : Promise.reject(new Error('not a movable key'))),
};
export const gitData = {
  get: (id) => kvGet('git:' + id).then((v) => v || null).catch(() => null),
  put: (id, v) => kvPut('git:' + id, v),
  remove: (id) => kvDel('git:' + id),
};
/**
 * The reply a chat is writing, saved on its own every few seconds while it runs (decision 258): the whole chat was saved
 * each time – a long agent chat is megabytes. On the next start a reply the app did not live to save with its chat is
 * put back from here.
 */
export const liveReplies = {
  put: (id, v) => putPlain((x) => kvPut('live:' + id, x), v),
  remove: (id) => kvDel('live:' + id),
  all: () =>
    db().then(
      (d) =>
        new Promise((res, rej) => {
          const r = d.transaction(KV_STORE).objectStore(KV_STORE).getAllKeys(IDBKeyRange.bound('live:', 'live:\uffff'));
          r.onsuccess = () => res((r.result || []).map((k) => String(k).slice(5)));
          r.onerror = () => rej(r.error);
        }),
    ).then((ids) => Promise.all(ids.map((id) => kvGet('live:' + id).then((v) => (v ? { id, ...v } : null))))).then((l) => l.filter(Boolean)),
};
/** Message vectors per chat (search by meaning, roleplay recall). */
export const vectors = {
  get: (id) => kvGet('vec:' + id).then((v) => v || null).catch(() => null),
  put: (id, v) => kvPut('vec:' + id, v),
  remove: (id) => kvDel('vec:' + id),
};
export const art = {
  keys: artKeys,
  read: (id) => kvGet('art:' + id).then((v) => v || null),
  get: async (id) => {
    if (!id) return null;
    if (artMem.has(id)) return artMem.get(id);
    let v = null;
    try {
      v = (await kvGet('art:' + id)) || null;
    } catch {
      /* ignore */
    }
    artMem.set(id, v);
    return v;
  },
  put: async (id, dataUrl) => {
    artMem.set(id, dataUrl || null);
    if (dataUrl) await kvPut('art:' + id, dataUrl);
    else await kvDel('art:' + id);
  },
  remove: (id) => art.put(id, null),
  all: () => db().then((d) => new Promise((res, rej) => {
    const out = {};
    const r = d.transaction(KV_STORE).objectStore(KV_STORE).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(out);
      if (String(c.key).startsWith('art:')) out[String(c.key).slice(4)] = c.value;
      c.continue();
    };
    r.onerror = () => rej(r.error);
  })),
};
const kvDel = (key) => db().then((d) => new Promise((res, rej) => {
  const t = d.transaction(KV_STORE, 'readwrite');
  t.objectStore(KV_STORE).delete(key);
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
}));
