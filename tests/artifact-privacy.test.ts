import { expect, it } from 'vitest';
import { contentFindings, privateArtifactPath, safeLocation } from '../scripts/artifact-privacy.mjs';
it.each(['.env', '.env.local', '.npmrc', '.git/config', '.cache/private.png', 'a/private-profile/config.json', 'a/auth.json', 'a/models.json', 'a/logs/main.txt', 'trace.har', 'developer.p12', 'signing.key', 'crash.heapsnapshot'])('excludes private artifact path %s', path => expect(privateArtifactPath(path)).toBe(true));
it.each(['.env.example', 'shared/config.ts', 'agent-host/models.ts', 'docs/API_AUTH.md', 'assets/characters/xiaoqi-green.png'])('allows reviewed source path %s', path => expect(privateArtifactPath(path)).toBe(false));
it('checks binary contents as well as text without exposing the matched value in reports', () => {
  const key = 'fixture-private-key-value';
  expect(contentFindings(Buffer.from(`\0${key}\0`), [key])).toEqual(['configured-service-key']);
  expect(contentFindings(Buffer.from('/fixture-home/private/file'), [], '/fixture-home')).toEqual(['local-home-path']);
  expect(safeLocation(`assets/${key}.png`, [key])).toBe('assets/[redacted].png');
});
