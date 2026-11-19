// Group chats: several personas in one conversation.
import { streamChat } from './api.js';
import { P } from './prompts.js';

export const GROUP_MODES = {
  auto: 'Natural – the conversation decides who replies',
  all: 'Everyone replies, in turn',
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Personas @mentioned in the text, in order of appearance (matches "@Name" or "@FirstWord"). */
export function mentionedMembers(text, members) {
  const hits = [];
  for (const p of members) {
    const names = [p.name, p.name.split(/\s+/)[0]].filter((v, i, a) => v && a.indexOf(v) === i);
    let best = -1;
    for (const n of names) {
      const m = new RegExp(`@${esc(n)}(?![\\p{L}\\p{N}_])`, 'iu').exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    if (best >= 0) hits.push([best, p]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/** Extra system prompt that tells a member it's in a group. */
export function groupBlock(me, members, scenario, lead = null, scene = null) {
  const others = members.filter((p) => p.id !== me.id);
  const notes = [];
  if (scene) notes.push(scene.id === me.id ? P('group_scene_self', { others: others.map((p) => p.name).join(', ') || 'none yet' }) : P('group_scene_other', { scene: scene.name }));
  if (lead) notes.push(lead.id === me.id ? P('group_lead_self') : P('group_lead_other', { lead: lead.name }));
  const focus = notes.length ? `\n${notes.join('\n')}\n` : '';
  return P('group_block', {
    name: me.name,
    others: others.length ? ' and these other participants:\n' + others.map((p) => `- ${p.name}${p.description ? ` – ${p.description}` : ''}`).join('\n') : '',
    focus,
    scenario: scenario?.trim() ? `\nScenario / group instructions:\n${scenario.trim()}\n` : '',
  });
}

/**
 * Ask a small model who should reply to the latest message, in order (from the context: who was
 * addressed, who is in the scene, who would naturally react). Resolves personas (may be empty).
 */
export function pickSpeakers(settings, { model, members, history, sessionId, lead = null, scene = null, user = 'User' }) {
  const roster = members.map((p) => `- ${p.name}${scene?.id === p.id ? ' (SCENARIO / NARRATOR)' : lead?.id === p.id ? ' (MAIN CHARACTER)' : ''}: ${(p.description || p.card?.description || p.prompt || '').slice(0, 160).replace(/\s+/g, ' ')}`).join('\n');
  const rules = scene ? P('group_rules_scene', { scene: scene.name, players: members.filter((p) => p.id !== scene.id).map((p) => p.name).join(', ') || 'none', username: user }) : lead ? P('group_rules_rp', { lead: lead.name, username: user }) : P('group_rules_chat');
  return new Promise((resolve) => {
    let out = '';
    streamChat(
      settings,
      {
        model,
        sessionId,
        temperature: 0,
        kind: 'group',
        messages: [
          {
            role: 'system',
            content: P('group_moderator', { roster, rules, username: user }),
          },
          { role: 'user', content: history.slice(-6000) },
        ],
      },
      {
        onContent: (t) => (out += t),
        onReasoning: () => {},
        onDone: () => {
          try {
            const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
            const names = (j.speakers || []).map((n) => String(n).toLowerCase().trim());
            const picked = names.map((n) => members.find((p) => p.name.toLowerCase() === n || p.name.split(/\s+/)[0].toLowerCase() === n)).filter(Boolean);
            resolve([...new Set(picked)].slice(0, 3));
          } catch {
            resolve([]);
          }
        },
        onError: () => resolve([]),
      },
    );
  });
}

/** Merge consecutive plain messages with the same role (some providers require alternating roles). */
export function mergeSameRole(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    const plain = (x) => x && typeof x.content === 'string' && !x.tool_calls && x.role !== 'tool' && x.role !== 'system';
    if (plain(prev) && plain(m) && prev.role === m.role) prev.content += '\n\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}
