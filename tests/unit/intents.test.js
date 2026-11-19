import { describe, it, expect } from 'vitest';
import { buildIntent, runIntentTool } from '../../src/intents.js';

describe('android_intent', () => {
  it('builds only allowed intents, with a summary for the user', () => {
    expect(buildIntent({ kind: 'dial', to: '+1 555 0100' }).intent).toEqual({ action: 'android.intent.action.DIAL', data: 'tel:%2B1%20555%200100' });
    expect(buildIntent({ kind: 'open_url', url: 'https://example.com' }).summary).toContain('example.com');
    expect(() => buildIntent({ kind: 'open_url', url: 'file:///sdcard/x' })).toThrow(/http/);
    expect(() => buildIntent({ kind: 'open_url', url: 'intent://x#Intent;end' })).toThrow();
    expect(() => buildIntent({ kind: 'dial', to: 'call me' })).toThrow(/number/);
    expect(() => buildIntent({ kind: 'launch_rocket' })).toThrow(/Unknown/);
    expect(() => buildIntent({ kind: 'open_app', package: '../etc' })).toThrow(/package/);
  });
  it('fills a calendar event, an alarm and a timer', () => {
    const ev = buildIntent({ kind: 'calendar_event', title: 'Dentist', start: '2026-11-14T15:00' }).intent;
    expect(ev.extras.endTime - ev.extras.beginTime).toBe(3600e3);
    expect(buildIntent({ kind: 'alarm', hour: 7, minute: 30 }).intent.extras['android.intent.extra.alarm.HOUR']).toBe(7);
    expect(() => buildIntent({ kind: 'alarm', hour: 25 })).toThrow();
    expect(buildIntent({ kind: 'timer', seconds: 300 }).summary).toContain('5 min');
    expect(buildIntent({ kind: 'email', to: 'a@b.co', subject: 'Hi there', text: 'x y' }).intent.data).toBe('mailto:a%40b.co?subject=Hi%20there&body=x%20y');
  });
  it('asks first, and does nothing when the user says no', async () => {
    const started = [];
    const ctx = { intents: { start: async (i) => started.push(i) }, ask: async () => 'Not now' };
    const r = await runIntentTool({ kind: 'map', query: 'Eiffel Tower' }, ctx);
    expect(r.ok).toBe(false);
    expect(started).toEqual([]);
    ctx.ask = async (q, opts) => opts[0];
    expect((await runIntentTool({ kind: 'map', query: 'Eiffel Tower' }, ctx)).ok).toBe(true);
    expect(started[0].data).toBe('geo:0,0?q=Eiffel%20Tower');
  });
});

describe('list_apps', () => {
  it('asks once per chat, then lists apps with their packages', async () => {
    let asked = 0;
    const ctx = { convId: 'c9', intents: { apps: async ({ query }) => ({ apps: [{ name: 'Spotify', package: 'com.spotify.music' }].filter((a) => !query || a.name.toLowerCase().includes(query)) }) }, ask: async (q, o) => (asked++, o[0]) };
    const r = await runIntentTool({ kind: 'list_apps', query: 'spot' }, ctx);
    expect(r.result).toBe('Spotify – com.spotify.music');
    await runIntentTool({ kind: 'list_apps' }, ctx);
    expect(asked).toBe(1);
  });
  it('says Chronicle itself is not listed when nothing matches (the app leaves its own package out on purpose)', async () => {
    const ctx = { convId: 'c10', intents: { apps: async () => ({ apps: [] }) }, ask: async (q, o) => o[0] };
    const r = await runIntentTool({ kind: 'list_apps', query: 'chronicle', all: true }, ctx);
    expect(r.result).toBe('No app matches "chronicle". (Chronicle itself is never listed: it is the app you are running in.)');
  });
});
