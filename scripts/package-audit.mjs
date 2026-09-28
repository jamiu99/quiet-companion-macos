// Verify an already built macOS app without running it or loading its config / agent / SDK.
import { lstatSync, readdirSync, readFileSync, realpathSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configuredSecrets, privateArtifactPath, contentFindings, safeLocation } from './artifact-privacy.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2);
const at = args.indexOf('--app');
if (at < 0 || !args[at + 1]) throw new Error('Usage: npm run audit:package -- --app /path/to/栖伴.app');
const app = realpathSync(resolve(args[at + 1])), base = join(app, 'Contents/Resources/app');
if (!app.endsWith('.app') || !existsSync(join(base, 'package.json'))) throw new Error('Expected an unpacked macOS app with Resources/app');
const secrets = configuredSecrets(root), findings = [], requiredFiles = {}, hashes = {}; let files = 0, bytes = 0;
const note = (location, rule) => findings.push({ location: safeLocation(location, secrets), rule });
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), rel = relative(app, path), own = relative(base, path), stat = lstatSync(path);
    if (privateArtifactPath(rel)) note(rel, 'private-artifact-path');
    if (stat.isSymbolicLink()) {
      if (!realpathSync(path).startsWith(app + sep)) note(rel, 'escaping-symlink');
      continue;
    }
    if (stat.isDirectory()) { walk(path); continue; }
    if (!stat.isFile()) { note(rel, 'unsupported-file'); continue; }
    files++; bytes += stat.size;
    const data = readFileSync(path);
    for (const rule of contentFindings(data, secrets, homedir())) note(rel, rule);
    for (const rule of contentFindings(Buffer.from(rel), secrets, undefined)) note(rel, rule);
    if (own.startsWith('dist/')) {
      if (name.endsWith('.map')) note(rel, 'own-source-map');
      const current = join(root, own);
      if (!existsSync(current) || !readFileSync(current).equals(data)) note(rel, 'build-mismatch');
      hashes[own] = createHash('sha256').update(data).digest('hex');
    }
  }
}
walk(app);
for (const file of ['dist/electron/main.cjs', 'dist/electron/preload.cjs', 'dist/agent-host/index.mjs', 'dist/renderer/companion/index.html', 'agent-host/prompts/companion.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) {
  requiredFiles[file] = existsSync(join(base, file)); if (!requiredFiles[file]) note(file, 'missing-required-file');
}
const report = { files, bytes, findings, requiredFiles, optionalRtcSdkIncluded: existsSync(join(base, 'dist/renderer/vendor/aliyun-rtc-sdk.js')), buildHashes: hashes, limitations: ['Exact current service keys and local home path scan, not proof of absence of all secrets', 'Does not establish signing, SDK redistribution permission, material rights or remote OAuth compatibility'] };
const out = join(root, '.cache/package-audit'); mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(`Package audit: ${files} files, ${Object.keys(hashes).length} build files; ${findings.length} findings`);
for (const f of findings) console.log(`REVIEW ${f.rule}: ${f.location}`);
console.log('Report: .cache/package-audit/report.json (no credential values)');
process.exitCode = findings.length ? 1 : 0;
