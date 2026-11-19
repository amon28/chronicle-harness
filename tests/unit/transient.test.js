import { describe, it, expect } from 'vitest';
import { isTransientError } from '../../src/transient.js';

describe('which errors are retried', () => {
  it('retries provider hiccups, network and TLS read errors', () => {
    for (const m of ['HTTP 520', 'Failed to fetch', 'Network error', 'timed out', 'SSLProtocolException: Read error: ssl=0xb40: Failure in SSL library, usually a protocol error error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT', 'javax.net.ssl.SSLException: Connection reset', 'unexpected end of stream', '429 overloaded, retry shortly']) expect(isTransientError(new Error(m))).toBe(true);
  });
  it('does not retry auth, limits or bad requests', () => {
    for (const m of ['HTTP 401 Invalid credential', 'You hit a usage limit', '400 bad request', '403 forbidden']) expect(isTransientError(new Error(m))).toBe(false);
  });
});

import { parseHeaders } from '../../src/mcp.js';
describe('MCP extra headers', () => {
  it('reads "Name: value" lines or a JSON object, and ignores junk', () => {
    expect(parseHeaders('X-Api-Key: abc123\nnot a header\nAuthorization: Bearer x:y')).toEqual({ 'X-Api-Key': 'abc123', Authorization: 'Bearer x:y' });
    expect(parseHeaders('{"X-Key": "v", "bad name": "z"}')).toEqual({ 'X-Key': 'v' });
    expect(parseHeaders('')).toEqual({});
  });
});
