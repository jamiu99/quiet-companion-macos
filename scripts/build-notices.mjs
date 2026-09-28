// Collect actual installed runtime license texts; metadata alone is not a complete notice.
import { readFileSync, readdirSync, existsSync, realpathSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(dirname(fileURLToPath(import.meta.url))), lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const sections = [], inventory = [], missing = [];
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/') || entry.dev && !/node_modules\/(react|react-dom|scheduler)$/.test(path)) continue;
  const dir = join(root, path), manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) { missing.push({ path, reason: 'package-not-installed' }); continue; }
  const p = JSON.parse(readFileSync(manifest, 'utf8')), prefix = realpathSync(dir) + '/';
  const files = readdirSync(dir).filter(n => /^(licen[cs]e|copying|notice)(?:[._-]|$)/i.test(n) && lstatSync(join(dir,n)).isFile());
  const items = [];
  for (const name of files) {
    const file = join(dir, name); if (!realpathSync(file).startsWith(prefix) || lstatSync(file).size > 1024*1024) throw new Error('License file requires manual review');
    const bytes = readFileSync(file); sections.push(`\n===== ${p.name}@${p.version} / ${name} =====\n${bytes.toString('utf8')}\n`); items.push({ file: name, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (!items.length) missing.push({ name: p.name, version: p.version, reason: 'no-root-license-text' });
  inventory.push({ name: p.name, version: p.version, license: p.license ?? 'UNCONFIRMED', files: items });
}
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build/THIRD_PARTY_LICENSES.txt'), 'Installed runtime dependency license texts. Electron/Chromium notices remain in their distribution. Optional RTC SDK excluded. This collection is not legal certification.\n' + sections.join(''));
writeFileSync(join(root, 'build/THIRD_PARTY_LICENSES.json'), JSON.stringify({ inventory, missing, limitations: ['Root license/notice files only; nested embedded code and upstream service obligations still require review'] }, null, 2));
console.log(`Runtime notices: ${inventory.length} packages; ${missing.length} require review. No credential files read.`);
if (missing.length) { for (const item of missing) console.log('REVIEW', item.name ?? item.path, item.reason); process.exitCode = 1; }
