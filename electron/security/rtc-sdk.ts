import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { RTC_SDK_MISSING, RTC_SDK_SHA256 } from '../../shared/rtcSdk';
/** Local preflight before Vidu HTTP creation, including tray, IPC and auto-connect paths. No network. */
export function requireRtcSdk(paths: string[]) {
  const path = paths.find(existsSync);
  if (!path || !lstatSync(path).isFile() || lstatSync(path).size > 5 * 1024 * 1024 || createHash('sha256').update(readFileSync(path)).digest('hex') !== RTC_SDK_SHA256) throw new Error(RTC_SDK_MISSING);
}
