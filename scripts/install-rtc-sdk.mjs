// Deliberately no downloader. Users obtain the SDK under their own upstream agreement.
import { readFileSync, lstatSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), at = args.indexOf('--file');
if (at < 0 || !args[at + 1] || !args.includes('--accept-upstream-terms')) throw new Error('Usage: npm run sdk:install -- --file /path/to/aliyun-rtc-sdk.js --accept-upstream-terms (confirm your own rights; no redistribution permission is granted)');
const root = dirname(dirname(fileURLToPath(import.meta.url))), file = resolve(args[at + 1]);
const pin = /RTC_SDK_SHA256 = '([a-f0-9]{64})'/.exec(readFileSync(join(root, 'shared/rtcSdk.ts'), 'utf8'))?.[1];
if (!pin || !lstatSync(file).isFile() || lstatSync(file).size > 5 * 1024 * 1024) throw new Error('Expected a regular SDK file, not a link / archive');
const bytes = readFileSync(file);
if (createHash('sha256').update(bytes).digest('hex') !== pin) throw new Error('SDK digest mismatch; review compatibility and provenance, do not bypass the pin');
const dest = join(root, 'assets/vendor/aliyun-rtc-sdk.js');
if (existsSync(dest)) { if (!readFileSync(dest).equals(bytes)) throw new Error('Refusing to overwrite a different SDK'); }
else { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 }); }
console.log('Optional local SDK installed. Rebuild before use. It remains excluded from the public-source export.');
