// Snapshot the CURRENT worktree (including uncommitted changes), not git archive HEAD and never the whole repo folder.
// No .git/history, ignored caches, user profiles, keys, node_modules or previous releases are copied.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync, readlinkSync, copyFileSync, constants } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configuredSecrets, privateArtifactPath, contentFindings, safeLocation } from './artifact-privacy.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2), at = args.indexOf('--out');
if (at < 0 || !args[at + 1]) throw new Error('Usage: npm run package:source -- --out /path/to/source.zip');
const out = resolve(args[at + 1]);
if (!out.endsWith('.zip') || existsSync(out)) throw new Error('Output must be a NEW .zip path (no overwrites)');
// This also checks reachable history for currently known credentials. It does not rewrite history or approve licenses.
execFileSync(process.execPath, [join(root, 'scripts/source-audit.mjs')], { cwd: root, stdio: 'inherit' });
const paths = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString().split('\0').filter(Boolean))].sort();
const roots = new Set(['.github', 'agent-host', 'assets', 'build', 'docs', 'electron', 'renderer', 'scripts', 'shared', 'site', 'tasks', 'tests']);
const rootFile = /^(?:[\w.-]+\.md|LICENSE(?:\.[\w-]+)?|package(?:-lock)?\.json|publication\.json|PUBLIC_SOURCE_MANIFEST\.json|tsconfig(?:\.[\w-]+)?\.json|(?:vite|vitest)\.config\.ts|\.gitignore|\.gitattributes|\.editorconfig|\.nvmrc|\.env\.example)$/;
const secrets = configuredSecrets(root), temp = mkdtempSync(join(tmpdir(), 'qc-source-export-')), stage = join(temp, 'quiet-companion-mac-source'), manifest = [];
try {
  for (const path of paths) {
    if (path === relative(root, out)) continue;
    if (path.includes('..') || (!roots.has(path.split('/')[0]) && !rootFile.test(path)) || privateArtifactPath(path)) throw new Error('Source export requires review: ' + safeLocation(path, secrets));
    const src = join(root, path); if (!existsSync(src)) continue; // Tracked deletions are absent from the current snapshot.
    // The repository's one intentional alias is exported as plain reviewed text, never an archive symlink.
    const alias = path === 'CLAUDE.md' && lstatSync(src).isSymbolicLink() && readlinkSync(src) === 'AGENTS.md';
    const input = alias ? join(root, 'AGENTS.md') : src, expected = alias ? 'AGENTS.md' : path;
    const stat = lstatSync(input); if (!stat.isFile() || realpathSync(input) !== join(realpathSync(root), expected)) throw new Error('No unreviewed links/directories in source file list: ' + safeLocation(path, secrets));
    const bytes = readFileSync(input);
    if (contentFindings(bytes, secrets, homedir()).length || contentFindings(Buffer.from(path), secrets).length) throw new Error('Private content found; export stopped (no values printed)');
    const dest = join(stage, path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, bytes, { mode: stat.mode & 0o111 ? 0o700 : 0o600, flag: 'wx' });
    manifest.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(alias ? { sourceAlias: 'AGENTS.md' } : {}) });
  }
  writeFileSync(join(stage, 'SOURCE_MANIFEST.json'), JSON.stringify({ type: 'private-source-candidate', files: manifest, exclusions: ['Git history/metadata', 'ignored files', 'user config/credentials', 'private media/logs', 'dependencies/builds/releases'], note: 'Not approval of source license, SDK redistribution or media rights' }, null, 2), { mode: 0o600 });
  const archive = join(temp, 'source.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', stage, archive]);
  execFileSync('/usr/bin/unzip', ['-tq', archive], { stdio: 'pipe' });
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(archive, out, constants.COPYFILE_EXCL);
  console.log(`Source candidate: ${manifest.length} files; archive integrity OK; ${out}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
