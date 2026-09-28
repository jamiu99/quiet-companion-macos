// Shared offline artifact checks. Reading project .env is explicit and memory-only, never userData / global auth.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function configuredSecrets(root) {
  const values = new Set();
  for (const name of ['VIDU_API_KEY', 'TOKENDANCE_API_KEY']) if (process.env[name]?.trim().length >= 12) values.add(process.env[name].trim());
  const file = join(root, '.env');
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:VIDU_API_KEY|TOKENDANCE_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) { const value = match[1].replace(/^["']|["']$/g, ''); if (value.length >= 12) values.add(value); }
  }
  return [...values];
}
export function privateArtifactPath(path) {
  const p = path.replaceAll('\\', '/');
  return /(^|\/)(?:\.git|\.cache|\.pi|\.pi-agent|private-profile|userData|logs)(?:\/|$)/i.test(p)
    || /(^|\/)(?:\.env(?:\..*)?|\.npmrc|auth\.json|models\.json|models-store\.json|config\.json|credentials(?:\.[^/]*)?\.json)$/i.test(p) && p !== '.env.example'
    || /\.(?:log|har|heapsnapshot|cpuprofile|pem|p12|pfx|key)$/i.test(p);
}
export function contentFindings(bytes, secrets, home) {
  const findings = [];
  if (secrets.some(key => bytes.includes(Buffer.from(key)))) findings.push('configured-service-key');
  if (home && bytes.includes(Buffer.from(home + '/'))) findings.push('local-home-path');
  return findings;
}
export function safeLocation(path, secrets) {
  for (const key of secrets) path = path.replaceAll(key, '[redacted]');
  return path;
}
