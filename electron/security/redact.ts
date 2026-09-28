// Defense in depth for diagnostic / renderer boundaries, not a substitute for keeping credentials out of messages.
const secrets = new Set<string>();
export function rememberSecrets(...values: string[]) {
  for (const value of values) {
    const raw = value.trim(), token = raw.replace(/^(Token|Bearer)\s+/i, '');
    if (raw.length >= 6) secrets.add(raw);
    if (token.length >= 6) secrets.add(token);
  }
}
export function redactSecrets(value: string): string {
  let text = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/\b(?:vda_|sk-)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+\/-]{12,}/gi, '[AUTH REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[TOKEN REDACTED]')
    .replace(/data:image\/[^\s"']+/g, '[IMAGE]');
}
/** Only JSON-like data crosses IPC here. Never apply to RTC session credentials: the receiver needs those. */
export function redactPayload<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactPayload) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactPayload(v)])) as T;
  return value;
}
