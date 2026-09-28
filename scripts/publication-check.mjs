import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function publicationCheck({ binary = false, website = false, directory = root } = {}) {
  const root = directory;
  const p = JSON.parse(readFileSync(join(root, 'publication.json'), 'utf8')), pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), problems = [];
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(p.repositoryUrl ?? '')) problems.push('Set the real new GitHub repository URL in publication.json');
  if (!['MIT', 'Apache-2.0'].includes(p.license) || pkg.license !== p.license) problems.push('Copyright holder must select a license; publication.json and package.json must agree');
  const license = join(root, 'LICENSE');
  if (!existsSync(license) || readFileSync(license, 'utf8').length < 900 || /\[fullname\]|\[year\]|<copyright holder>/i.test(readFileSync(license, 'utf8'))) problems.push('Approved full LICENSE text / attribution is missing or still a template');
  if (website) { try { const u = new URL(p.homepageUrl); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.hostname.includes('.') || /example\.(com|org)|localhost|\.invalid$/.test(u.hostname)) throw new Error(); } catch { problems.push('Set the real public HTTPS homepage URL before indexing / deploying a website'); } }
  if (existsSync(join(root, 'assets/vendor/aliyun-rtc-sdk.js')) || binary && existsSync(join(root, 'dist/renderer/vendor/aliyun-rtc-sdk.js'))) problems.push('Unconfirmed RTC SDK must not be part of public source / binary distribution');
  const provenance = join(root, 'assets/PROVENANCE.json'), allowed = new Set(['assets/PROVENANCE.json']);
  if (!existsSync(provenance)) problems.push('Original demo asset provenance is missing; use prepare:public, not the old worktree');
  else for (const f of JSON.parse(readFileSync(provenance, 'utf8')).files ?? []) {
    if (!/^(assets|build|docs\/media)\//.test(f.path) || f.path.includes('..') || !/^[a-f0-9]{64}$/.test(f.sha256)) { problems.push('Invalid asset provenance entry'); continue; }
    allowed.add(f.path); const path = join(root, f.path);
    if (!existsSync(path) || !lstatSync(path).isFile() || realpathSync(path) !== join(realpathSync(root), f.path) || createHash('sha256').update(readFileSync(path)).digest('hex') !== f.sha256) problems.push(`Asset needs provenance review: ${f.path}`);
  }
  for (const path of ['assets/characters/xiaoqi-green.png', 'assets/characters/xiaoqi-idle.webm', 'build/icon.png', 'docs/media/social-preview.png']) if (!allowed.has(path)) problems.push(`Required original demo asset missing: ${path}`);
  function walk(dir, prefix) { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const rel=prefix+name, path=join(dir,name); if (lstatSync(path).isDirectory()) walk(path, rel+'/'); else if (!allowed.has(rel)) problems.push(`Unreviewed asset: ${rel}`); } }
  walk(join(root, 'assets'), 'assets/');
  function reviewDocs(dir, prefix = 'docs/') {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const rel = prefix + name, path = join(dir, name), stat = lstatSync(path);
      if (stat.isDirectory()) reviewDocs(path, rel + '/');
      else if (!stat.isFile() || !rel.endsWith('.md') && !allowed.has(rel)) problems.push(`Unreviewed documentation artifact: ${rel}`);
    }
  }
  reviewDocs(join(root, 'docs'));
  if (binary) { const report = join(root, 'build/THIRD_PARTY_LICENSES.json'); if (!existsSync(report) || JSON.parse(readFileSync(report, 'utf8')).missing.length) problems.push('Runtime license text collection incomplete'); }
  return { publication: p, problems };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems } = publicationCheck({ binary: process.argv.includes('--binary'), website: process.argv.includes('--website') });
  for (const p of problems) console.log('BLOCKED:', p);
  console.log(problems.length ? `${problems.length} publication checks pending; nothing published.` : 'Static publication checks passed; signing, rights and real-service acceptance still need human review.');
  process.exitCode = problems.length ? 1 : 0;
}
