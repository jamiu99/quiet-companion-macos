// Offline source / reachable-history scan. Never print matched credential values; private .env is read only in memory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateArtifactPath } from './artifact-privacy.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), out = join(root, '.cache/source-audit');
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 80 * 1024 * 1024, ...options });
const known = new Set();
for (const key of ['VIDU_API_KEY', 'TOKENDANCE_API_KEY']) if (process.env[key]?.trim().length >= 12) known.add(process.env[key].trim());
const envFile = join(root, '.env');
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^\s*(?:VIDU_API_KEY|TOKENDANCE_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) { const value = m[1].replace(/^["']|["']$/g, ''); if (value.length >= 12) known.add(value); }
}
const findings = [], skipped = [];
function scan(bytes, location, oid) {
  const report = rule => findings.push({ location, ...(oid ? { oid } : {}), rule });
  if ([...known].some(key => bytes.includes(Buffer.from(key)))) report('configured-service-key');
  // Binary image contents cannot be visually inspected by a string scan. Still check exact key bytes above.
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  const matches = text.match(/\b(?:vda_|sk-)[A-Za-z0-9_-]{20,}/g) ?? [];
  // Two manually reviewed preview-only constants in mock.ts; exact hashes, NOT a blanket exclusion of that file.
  const previewSentinels = new Set(['335717dd4ac06bc20c18efd47a771e0ccd0c5beca07d5e8785f85f9a878690f1', '3b2e3d3f437e17e621b2dd107edf53aaf385d5bfd26b759ddcea624aee4a06a5']);
  if (matches.some(m => !(location === 'renderer/shared/mock.ts' && previewSentinels.has(createHash('sha256').update(m).digest('hex'))) && !/(?:example|fixture|dummy|placeholder|demo|test|your[_-]?key|x{6}|0{6})/i.test(m))) report('credential-shaped-string');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) report('private-key-header');
}
const files = [...new Set(git(['ls-files', '-co', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean))];
for (const file of files) {
  const path = resolve(root, file); if (!existsSync(path) || !statSync(path).isFile()) continue;
  if (statSync(path).size > 64 * 1024 * 1024) { skipped.push(file); continue; }
  if (privateArtifactPath(file)) findings.push({ location: file, rule: 'sensitive-filename-review' });
  scan(readFileSync(path), file);
}
const objects = git(['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf(' '); return { oid: i < 0 ? line : line.slice(0, i), path: i < 0 ? '(git object)' : line.slice(i + 1) }; });
const metadata = git(['cat-file', '--batch-check=%(objecttype) %(objectsize)'], { input: objects.map(o => o.oid).join('\n') + '\n' }).toString().trim().split('\n');
let blobs = 0, historyMetadata = 0;
for (const [i, object] of objects.entries()) {
  const [type, size] = metadata[i].split(' '); if (!['blob', 'commit', 'tag'].includes(type)) continue;
  if (Number(size) > 64 * 1024 * 1024) { skipped.push(object.oid); continue; }
  scan(git(['cat-file', type, object.oid]), object.path, object.oid);
  if (type === 'blob') blobs++; else historyMetadata++;
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const licenses = Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
  if (!path.startsWith('node_modules/')) return [];
  const manifest = join(root, path, 'package.json'); if (!existsSync(manifest)) return [];
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  return [{ name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNCONFIRMED', runtime: !entry.dev || ['react', 'react-dom', 'scheduler'].includes(pkg.name) }];
}).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const vendor = join(root, 'assets/vendor/aliyun-rtc-sdk.js');
const blockers = [];
if (!['LICENSE', 'LICENSE.md', 'LICENSE.txt'].some(file => existsSync(join(root, file)))) blockers.push('Repository license not selected by the copyright owner');
if (existsSync(vendor)) blockers.push('AliRTC vendored binary redistribution permission / upstream license must be confirmed');
for (const pkg of licenses.filter(p => p.runtime && /UNCONFIRMED|UNLICENSED|GPL/.test(p.license))) blockers.push(`Review runtime license obligations: ${pkg.name}@${pkg.version} (${pkg.license})`);
const report = { workingFiles: files.length, commits: Number(git(['rev-list', '--all', '--count']).toString()), historyBlobs: blobs, historyMetadata, findings, skipped, releaseBlockers: blockers, vendor: existsSync(vendor) ? { file: 'assets/vendor/aliyun-rtc-sdk.js', sha256: createHash('sha256').update(readFileSync(vendor)).digest('hex') } : undefined, licenses,
  limitations: ['Heuristic / exact-current-key scan, not proof that history contains no secrets', 'Screenshots, generated-media rights, unrecognized credentials and service terms need manual review', 'SPDX metadata is not a complete third-party notice or legal opinion', 'Does not scan ignored private cache / user config or upload any content'] };
mkdirSync(out, { recursive: true, mode: 0o700 }); writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(`Source audit: ${files.length} working files, ${report.commits} commits, ${blobs} history blobs; ${findings.length} findings, ${skipped.length} skipped`);
for (const finding of findings) console.log(`REVIEW ${finding.rule}: ${finding.location}${finding.oid ? ` (${finding.oid.slice(0, 12)})` : ''}`);
for (const blocker of blockers) console.log(`RELEASE BLOCKER: ${blocker}`);
console.log('Report: .cache/source-audit/report.json (no credential values)');
process.exitCode = findings.length || skipped.length || process.argv.includes('--release') && blockers.length ? 1 : 0;
