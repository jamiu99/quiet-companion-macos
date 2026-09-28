import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { publicationCheck } from '../scripts/publication-check.mjs';
import { requireRtcSdk } from '../electron/security/rtc-sdk';
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qc-publication-')); dirs.push(dir);
  const put = (path: string, text: string) => { mkdirSync(dirname(join(dir,path)), { recursive: true }); writeFileSync(join(dir,path), text); };
  put('publication.json', JSON.stringify({ repositoryUrl: '', homepageUrl: '', license: '' })); put('package.json', '{}');
  return { dir, put };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
it('blocks missing publisher/license/art rights rather than claiming open-source readiness', () => {
  const f=fixture(), {problems}=publicationCheck({ directory:f.dir, website:true });
  expect(problems.some(s=>s.includes('repository'))).toBe(true); expect(problems.some(s=>s.includes('LICENSE'))).toBe(true); expect(problems.some(s=>s.includes('provenance'))).toBe(true); expect(problems.some(s=>s.includes('homepage'))).toBe(true);
});
it('blocks installed RTC SDK and unreviewed images even when they are ignored by Git', () => {
  const f=fixture(); f.put('assets/vendor/aliyun-rtc-sdk.js','fixture-not-the-sdk'); f.put('assets/private.png','fixture-private');
  const {problems}=publicationCheck({ directory:f.dir });
  expect(problems.some(s=>s.includes('RTC SDK'))).toBe(true); expect(problems.some(s=>s.includes('private.png'))).toBe(true);
});
it('detects changed art against the recorded source provenance', () => {
  const f=fixture(), hash=createHash('sha256').update('fixture-original').digest('hex');
  f.put('assets/PROVENANCE.json', JSON.stringify({ files:[{ path:'assets/demo.png', sha256:hash }] })); f.put('assets/demo.png','fixture-replaced');
  expect(publicationCheck({ directory:f.dir }).problems).toContain('Asset needs provenance review: assets/demo.png');
});
it('rejects historical documentation screenshots and generation logs outside asset provenance', () => {
  const f=fixture(); f.put('docs/screenshots/old-ui.png','fixture-image'); f.put('docs/idle-video-runs.jsonl','fixture-log');
  const {problems}=publicationCheck({ directory:f.dir });
  expect(problems).toContain('Unreviewed documentation artifact: docs/screenshots/old-ui.png');
  expect(problems).toContain('Unreviewed documentation artifact: docs/idle-video-runs.jsonl');
});
it('requires RTC integrity before any runtime starts, without network', () => {
  const f=fixture(); expect(()=>requireRtcSdk([join(f.dir,'missing.js')])).toThrow('未创建付费会话');
  f.put('sdk.js','fixture-corrupt'); expect(()=>requireRtcSdk([join(f.dir,'sdk.js')])).toThrow('未创建付费会话');
});
