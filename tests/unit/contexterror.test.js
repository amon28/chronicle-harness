import { describe, it, expect } from 'vitest';
import { parseContextError, fitAfterContextError } from '../../src/contexterror.js';

describe('"too long for this model" errors', () => {
  it('OpenAI-style, with the limit and what was asked', () => {
    expect(parseContextError("This model's maximum context length is 32768 tokens. However, your messages resulted in 41022 tokens. Please reduce the length of the messages.")).toEqual({ limit: 32768, requested: 41022 });
  });
  it('Anthropic, vLLM, Google and other wordings', () => {
    expect(parseContextError('prompt is too long: 210515 tokens > 200000 maximum')).toEqual({ limit: 200000, requested: 210515 });
    expect(parseContextError("This model's maximum context length is 8192 tokens and your request has 9000 input tokens")).toMatchObject({ limit: 8192 });
    expect(parseContextError('The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).')).toEqual({ limit: 1048576, requested: 1100000 });
    expect(parseContextError('context_length_exceeded')).toEqual({ limit: 0, requested: 0 });
    expect(parseContextError('Request too large for model: max_model_len=16384')).toMatchObject({ limit: 16384 });
  });
  it('other errors are not taken for it', () => {
    expect(parseContextError('Rate limit reached: 60000 tokens per minute')).toBeNull();
    expect(parseContextError('Invalid API key')).toBeNull();
    expect(parseContextError('max_tokens must be at least 1')).toBeNull();
  });
  it('the rebuilt request aims under the limit', () => {
    expect(fitAfterContextError({ limit: 32768, requested: 41022 }, 0)).toBe(27852);
    expect(fitAfterContextError({ limit: 0, requested: 50000 }, 0)).toBe(35000);
    expect(fitAfterContextError({ limit: 0, requested: 0 }, 20000)).toBe(12000);
  });
  it('rate limits that count tokens are not taken for "too long", and string-size limits are not context sizes', () => {
    expect(parseContextError('429 Too many tokens, please wait before trying again')).toBeNull();
    expect(parseContextError('Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 41000.')).toBeNull();
    expect(parseContextError("Invalid 'messages[1].content': string too long. Expected a string with maximum length 10485760")).toBeNull();
  });
  it('the reply space counts: Anthropic and vLLM say how much, and it comes off the fit', () => {
    const a = parseContextError('input length and `max_tokens` exceed context limit: 190000 + 64000 > 200000, decrease input length or `max_tokens` and try again');
    expect(a).toEqual({ limit: 200000, requested: 190000, completion: 64000 });
    expect(fitAfterContextError(a, 0)).toBe(106000);
    const v = parseContextError("This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (5000 in the messages, 4000 in the completion).");
    expect(v).toMatchObject({ limit: 8192, completion: 4000 });
    expect(fitAfterContextError(v, 0)).toBe(2963);
  });
});
