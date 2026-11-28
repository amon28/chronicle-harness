import { describe, it, expect, beforeEach } from 'vitest';
import { deviceDefs, eventLine, forgetDeviceOks, parseWhen, runDeviceTool } from '../../src/device.js';
import { isWriteCall } from '../../src/planmode.js';
import { TOOL_GROUPS, applyToolset } from '../../src/toolset.js';

function fakeDevice() {
  const calls = [];
  return {
    calls,
    calendars: async () => ({ calendars: [{ id: 3, name: 'Personal', account: 'me@x', primary: true, writable: true }, { id: 4, name: 'Holidays', account: 'Holidays', writable: false }] }),
    events: async (o) => (calls.push(['events', o]), { events: [{ id: 1, title: 'Dentist', start: new Date(2026, 10, 14, 15, 0).getTime(), end: new Date(2026, 10, 14, 16, 0).getTime(), allDay: false, location: 'Main St', calendar: 'Personal' }] }),
    addEvent: async (o) => (calls.push(['add', o]), { id: 77, calendar: 'Personal' }),
    contacts: async (o) => (calls.push(['contacts', o]), { contacts: [{ name: 'Ana', phones: [{ label: 'Mobile', value: '+1 555' }], emails: [] }] }),
    location: async (o) => (calls.push(['location', o]), { lat: 48.86, lon: 2.35, accuracy: 1000, precise: !!o.precise, time: Date.now(), address: 'Paris, France' }),
  };
}

describe('device tools (calendar, contacts, location)', () => {
  beforeEach(() => forgetDeviceOks());

  it('offers three tools, and only adding an event counts as a change', () => {
    expect(deviceDefs().map((d) => d.function.name)).toEqual(['calendar', 'contacts', 'location']);
    expect(isWriteCall('calendar', { action: 'add' })).toBe(true);
    expect(isWriteCall('calendar', { action: 'list' })).toBe(false);
    expect(isWriteCall('location', {})).toBe(false);
    expect(TOOL_GROUPS.some(([k]) => k === 'device')).toBe(true);
    expect(applyToolset({ device: true }, { device: false }).device).toBe(false);
  });

  it('reads dates as local time', () => {
    expect(parseWhen('2026-11-14')).toBe(new Date(2026, 10, 14).getTime());
    expect(parseWhen('2026-11-14T15:00')).toBe(new Date(2026, 10, 14, 15, 0).getTime());
    expect(Number.isNaN(parseWhen('soon'))).toBe(true);
    expect(eventLine({ title: 'Dentist', start: new Date(2026, 10, 14, 15).getTime(), end: new Date(2026, 10, 14, 16).getTime() })).toMatch(/^Sat 14 Nov 2026 15:00–16:00 · Dentist/);
    // all-day events are stored at midnight UTC
    expect(eventLine({ title: 'Trip', allDay: true, start: Date.UTC(2026, 10, 20), end: Date.UTC(2026, 10, 23) })).toMatch(/^Fri 20 Nov 2026 \(all day, 3 days\) · Trip/);
  });

  it('asks once per chat before reading, and stops when the user says no', async () => {
    const dev = fakeDevice();
    let asked = 0;
    let answer = 'Not now';
    const ctx = { device: dev, convId: 'c1', ask: async () => (asked++, answer) };
    const no = await runDeviceTool('calendar', {}, ctx);
    expect(no.ok).toBe(false);
    expect(dev.calls).toEqual([]);
    answer = 'Allow';
    const r = await runDeviceTool('calendar', { query: 'dent' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('Dentist');
    expect(dev.calls[0][1].query).toBe('dent');
    await runDeviceTool('calendar', { action: 'calendars' }, ctx);
    expect(asked).toBe(2); // the second read did not ask again
    // another chat asks again
    await runDeviceTool('calendar', {}, { ...ctx, convId: 'c2' });
    expect(asked).toBe(3);
  });

  it('the OK is kept with the chat: after the app starts again it is not asked again (decision 270)', async () => {
    const kept = new Set();
    const deviceOks = { has: (w) => kept.has(w), add: (w) => kept.add(w) };
    let asked = 0;
    const ctx = { device: fakeDevice(), convId: 'k1', deviceOks, ask: async () => (asked++, 'Allow') };
    await runDeviceTool('calendar', {}, ctx);
    expect([...kept]).toEqual(['calendar']);
    forgetDeviceOks(); // the app run is over
    await runDeviceTool('calendar', {}, ctx);
    expect(asked).toBe(1);
  });

  it('a span past a year, and a full page of events or contacts, are said (decision 270)', async () => {
    const dev = fakeDevice();
    const ctx = { device: dev, convId: 'span1', ask: async () => 'Allow' };
    const r = await runDeviceTool('calendar', { from: '2026-01-01', to: '2028-01-01', limit: 1 }, ctx);
    expect(dev.calls.at(-1)[1].to - dev.calls.at(-1)[1].from).toBe(366 * 86400000);
    expect(r.result).toMatch(/\[only one year from the start is read at a time – ask again from .* for later dates; these are the first 1; more may exist – narrow the dates or the query, or raise limit \(up to 200\)\]$/);
    const c = await runDeviceTool('contacts', { query: 'a', limit: 1 }, ctx);
    expect(c.result).toMatch(/\[the first 1; more may match/);
    const one = await runDeviceTool('contacts', { query: 'a' }, ctx);
    expect(one.result).not.toMatch(/more may match/);
  });

  it('a date as the end of a range means the whole day', async () => {
    const dev = fakeDevice();
    const ctx = { device: dev, convId: 'c', ask: async (q, o) => o[0] };
    await runDeviceTool('calendar', { from: '2026-11-14', to: '2026-11-14' }, ctx);
    const o = dev.calls[0][1];
    expect(o.from).toBe(new Date(2026, 10, 14).getTime());
    expect(o.to).toBe(new Date(2026, 10, 15).getTime() - 1);
  });

  it('adds an event only after the user agrees, every time', async () => {
    const dev = fakeDevice();
    const qs = [];
    const ctx = { device: dev, convId: 'c', ask: async (q, o) => (qs.push(q), o[0]) };
    const r = await runDeviceTool('calendar', { action: 'add', title: 'Dentist', start: '2026-11-14T15:00', reminder_minutes: 30 }, ctx);
    expect(r.ok).toBe(true);
    expect(qs[0]).toMatch(/Add to your calendar\?[\s\S]*Dentist[\s\S]*15:00–16:00[\s\S]*reminder 30 min/);
    const sent = dev.calls.find((c) => c[0] === 'add')[1];
    expect(sent.end - sent.start).toBe(3600e3);
    expect(sent.reminderMinutes).toBe(30);
    await runDeviceTool('calendar', { action: 'add', title: 'Again', start: '2026-11-15' }, ctx);
    expect(qs.length).toBe(2);
    expect((await runDeviceTool('calendar', { action: 'add', title: 'x' }, ctx)).ok).toBe(false); // no start
    const declined = await runDeviceTool('calendar', { action: 'add', title: 'No', start: '2026-11-16' }, { ...ctx, ask: async () => 'Not now' });
    expect(declined.ok).toBe(false);
    expect(dev.calls.filter((c) => c[0] === 'add').length).toBe(2);
  });

  it('contacts and location; precise location is its own question', async () => {
    const dev = fakeDevice();
    const qs = [];
    const ctx = { device: dev, convId: 'c', ask: async (q, o) => (qs.push(q), o[0]) };
    expect((await runDeviceTool('contacts', { query: 'an' }, ctx)).result).toBe('Ana · Mobile: +1 555');
    const loc = await runDeviceTool('location', {}, ctx);
    expect(loc.result).toMatch(/Paris, France\n48.86, 2.35 \(±1000 m, approximate\)/);
    expect(qs.at(-1)).toMatch(/approximate/);
    await runDeviceTool('location', { precise: true }, ctx);
    expect(qs.at(-1)).toMatch(/exact location/);
    expect(dev.calls.at(-1)).toEqual(['location', { precise: true }]);
  });

  it('says plainly when Android refused, or when it is not the Android app', async () => {
    const dev = { ...fakeDevice(), location: async () => Promise.reject(Object.assign(new Error('The user did not allow the location.'), { code: 'DENIED' })) };
    const r = await runDeviceTool('location', {}, { device: dev, ask: async (q, o) => o[0] });
    expect(r.ok).toBe(false);
    expect(r.display.error).toBe('not allowed');
    expect((await runDeviceTool('contacts', {}, {})).result).toMatch(/only available in the Android app/);
  });
});

describe('a status line while a call waits for Android', () => {
  beforeEach(() => forgetDeviceOks());
  it('says "Waiting for Android…" after the OK, while the native call runs (calendar, contacts, intents, phone controls)', async () => {
    const { runIntentTool } = await import('../../src/intents.js');
    const { runPhoneCtlTool } = await import('../../src/phonectl.js');
    const status = [];
    const during = [];
    const at = (what, v) => (during.push([what, status.at(-1)]), v);
    const dev = { calendars: async () => at('calendars', { calendars: [] }), contacts: async () => at('contacts', { contacts: [] }), addEvent: async () => at('addEvent', { id: 1 }) };
    const ctx = { convId: 'cs', device: dev, ask: async (q, o) => o[0], onStatus: (s) => status.push(s), intents: { start: async () => at('intent', { opened: true }), apps: async () => at('apps', { apps: [] }) }, phoneCtl: { control: async () => at('vibrate', { vibrated: true }) } };
    await runDeviceTool('calendar', { action: 'calendars' }, ctx);
    await runDeviceTool('calendar', { action: 'add', title: 'X', start: '2026-11-14T15:00' }, ctx);
    await runDeviceTool('contacts', { query: 'a' }, ctx);
    await runIntentTool({ kind: 'calendar_event', title: 'X', start: '2026-11-14T15:00' }, ctx);
    await runIntentTool({ kind: 'list_apps' }, ctx);
    await runPhoneCtlTool('phone_control', { action: 'vibrate', ms: 200 }, ctx);
    expect(during).toEqual(['calendars', 'addEvent', 'contacts', 'intent', 'apps', 'vibrate'].map((w) => [w, 'Waiting for Android…']));
  });
});
