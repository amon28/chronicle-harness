// Which request errors are worth trying again (provider hiccups, network and TLS read errors) and which are not.
export const OVERLOADED_RX = /overloaded|upstream request failed|retry shortly|temporarily unavailable/i;
/** Errors worth retrying: the provider's 5xx / Cloudflare errors and network hiccups (not auth, limits or bad requests). */
export function isTransientError(e) {
  const t = String(e?.message || e);
  if (OVERLOADED_RX.test(t)) return true; // 429 "overloaded": the provider is busy, not your limit
  if (/usage limit|FreeUsageLimit|AuthError|Invalid (credential|API)|not available in your country|\b(400|401|402|403|404|413|422|429)\b/i.test(t)) return false;
  return /HTTP 5\d\d\b|Failed to fetch|Network error|network|timed? ?out|ECONN|ETIMEDOUT|socket|stream (ended|closed)|load failed|SSL|TLS|BAD_DECRYPT|BAD_RECORD_MAC|Connection (reset|closed|abort)|unexpected end of stream|handshake|EOFException|Read error/i.test(t);
}
