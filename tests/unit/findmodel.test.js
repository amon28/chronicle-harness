// Decision 267: a model asked for by name or by its bare id is found – "use Claude Opus" was refused with a list that
// held that very model under a provider-prefixed id
import { describe, it, expect } from 'vitest';
import { findModel, delegatePrompt, delegateDefs } from '../../src/delegate.js';

const models = [
  { id: 'anthropic:claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'anthropic:claude-opus-5', name: 'Claude Opus 5' },
  { id: 'anthropic:claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'openrouter/kimi-k3', name: 'Kimi K3' },
];

describe('finding a model by what it was called', () => {
  it('its id, its name in any case, or its id without the provider in front', () => {
    expect(findModel(models, 'glm-5.3')).toEqual({ id: 'glm-5.3' });
    expect(findModel(models, 'claude opus 5.5')).toEqual({ id: 'anthropic:claude-opus-5-5' });
    expect(findModel(models, 'claude-opus-5-5')).toEqual({ id: 'anthropic:claude-opus-5-5' }); // the bare API id
    expect(findModel(models, 'kimi-k3')).toEqual({ id: 'openrouter/kimi-k3' });
  });
  it('spaces, dots and dashes do not matter; words that fit one model find it', () => {
    expect(findModel(models, 'Claude-Opus-5.5')).toEqual({ id: 'anthropic:claude-opus-5-5' });
    expect(findModel(models, 'haiku')).toEqual({ id: 'anthropic:claude-haiku-5-5' });
    expect(findModel(models, 'opus 5.5')).toEqual({ id: 'anthropic:claude-opus-5-5' });
    expect(findModel(models, 'GLM 5.3')).toEqual({ id: 'glm-5.3' });
  });
  it('words that fit several give them all; none gives nothing', () => {
    expect(findModel(models, 'Claude Opus').candidates.map((m) => m.id)).toEqual(['anthropic:claude-opus-5-5', 'anthropic:claude-opus-5']);
    expect(findModel(models, 'gpt-7')).toEqual({});
    expect(findModel(models, '')).toEqual({});
  });
  it('the main model is told to use delegate for a model named by the user, and the tool takes names (no fixed list)', () => {
    expect(delegatePrompt()).toMatch(/asks for another model by name/);
    const d = delegateDefs([], models, 'glm-5.3')[0].function.parameters.properties.model;
    expect(d.enum).toBeUndefined();
    expect(d.description).toContain('anthropic:claude-opus-5-5 (Claude Opus 5.5)');
  });
});
