import { describe, it, expect } from 'vitest';
import { modelAbilities } from '../../src/modelcaps.js';

describe('each model says what it can do', () => {
  it('OpenRouter: images, tools, reasoning and limits per model', () => {
    const vision = modelAbilities({ id: 'x/vl', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'], context_length: 128000, top_provider: { context_length: 65536, max_completion_tokens: 8192 } }, { vision: false, tools: false });
    expect(vision).toEqual({ tools: true, vision: true, reasoning: true, context: 65536, output: 8192 });
    const plain = modelAbilities({ id: 'y/txt', architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'], context_length: 32000 }, { vision: true, tools: true });
    expect(plain).toMatchObject({ tools: false, vision: false, reasoning: false, context: 32000 });
  });
  it('Mistral-style and models.dev-style fields', () => {
    expect(modelAbilities({ capabilities: { vision: true, function_calling: false } }, {})).toMatchObject({ vision: true, tools: false });
    expect(modelAbilities({ modalities: { input: ['text', 'image'] }, capabilities: { tools: { supported: true }, reasoning: { supported: true } }, limit: { context: 200000, output: 64000 } }, {})).toEqual({ tools: true, vision: true, reasoning: true, context: 200000, output: 64000 });
  });
  it('a model with nothing to say: the provider switches decide, and the name is never used', () => {
    expect(modelAbilities({ id: 'gpt-4o-vision-tools-thinking' }, { vision: false, tools: false, context: 0 })).toEqual({ tools: false, vision: false, reasoning: false, context: 32768, output: undefined });
    expect(modelAbilities({ id: 'm' }, { vision: true, context: 100000 })).toMatchObject({ tools: true, vision: true, context: 100000 });
  });
});
