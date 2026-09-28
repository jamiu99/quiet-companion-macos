// New local repository, never reset/clean/push the working repository or copy its Git history.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readlinkSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { configuredSecrets, contentFindings, privateArtifactPath } from './artifact-privacy.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2), at = args.indexOf('--out');
if (at < 0 || !args[at+1]) throw new Error('Usage: npm run prepare:public -- --out /new/path/quiet-companion-mac');
const out = resolve(args[at+1]); if (existsSync(out) || out.startsWith(root + '/')) throw new Error('Use a NEW directory outside the existing worktree');
execFileSync(process.execPath, [join(root, 'scripts/source-audit.mjs')], { cwd: root, stdio: 'inherit' });
const files = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(Boolean))].sort();
const roots = new Set(['.github', 'agent-host', 'docs', 'electron', 'renderer', 'scripts', 'shared', 'site', 'tests']);
const rootFile = /^(?:[\w.-]+\.md|LICENSE(?:\.[\w-]+)?|package(?:-lock)?\.json|publication\.json|tsconfig(?:\.[\w-]+)?\.json|(?:vite|vitest)\.config\.ts|\.gitignore|\.gitattributes|\.editorconfig|\.nvmrc|\.env\.example)$/;
const secrets = configuredSecrets(root); mkdirSync(out, { recursive: true, mode: 0o700 });
for (const path of files) {
  if (/^(assets\/|build\/|tasks\/|docs\/media\/)/.test(path) || path.startsWith('docs/') && !path.endsWith('.md') || path === 'PUBLIC_SOURCE_MANIFEST.json' || path === 'SOURCE_MANIFEST.json') continue;
  if ((!roots.has(path.split('/')[0]) && !rootFile.test(path)) || path.includes('..') || privateArtifactPath(path)) throw new Error('Unreviewed source path; export stopped');
  const src = join(root, path); if (!existsSync(src)) continue;
  const alias = path === 'CLAUDE.md' && lstatSync(src).isSymbolicLink() && readlinkSync(src) === 'AGENTS.md';
  const input = alias ? join(root, 'AGENTS.md') : src, expected = alias ? 'AGENTS.md' : path;
  const stat = lstatSync(input);
  if (!stat.isFile() || realpathSync(input) !== join(realpathSync(root), expected)) throw new Error('Unreviewed symlink; export stopped');
  const bytes = readFileSync(input);
  if (contentFindings(bytes, secrets, homedir()).length || contentFindings(Buffer.from(path), secrets).length) throw new Error('Private content detected; no values printed');
  const dest = join(out, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { flag: 'wx', mode: stat.mode & 0o111 ? 0o700 : 0o600 });
}
execFileSync(process.execPath, [join(root, 'scripts/generate-public-art.mjs'), '--out', out], { stdio: 'inherit' });
const manifest = [];
function inventory(dir, prefix='') { for (const name of readdirSync(dir)) { const rel = prefix + name, path = join(dir, name); if (lstatSync(path).isDirectory()) inventory(path, rel + '/'); else { const data = readFileSync(path); if (contentFindings(data, secrets, homedir()).length) throw new Error('Private generated content detected'); manifest.push({ path: rel, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); } } }
inventory(out);
writeFileSync(join(out, 'PUBLIC_SOURCE_MANIFEST.json'), JSON.stringify({ type: 'unpublished-source-candidate', files: manifest, exclusions: ['old Git history/identity/remote', 'unconfirmed RTC SDK', 'all previous media/icons', 'historical tasks', 'private data/config/logs/cache', 'dependencies/build outputs'], licenseGrantedByExportTool: false }, null, 2), { flag: 'wx', mode: 0o600 });
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = args => execFileSync('git', ['-C', out, ...args], { stdio: 'pipe', env: gitEnv });
git(['init', '--template=', '-b', 'main']);
git(['config', 'user.useConfigOnly', 'true']); git(['config', 'user.name', '']); git(['config', 'user.email', '']);
console.log(`Prepared ${manifest.length} files in ${out}; no commits, remote or previous author identity. License/publisher approval still required.`);
