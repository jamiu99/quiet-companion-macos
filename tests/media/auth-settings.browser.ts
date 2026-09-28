import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SettingsDrawer } from '../../renderer/companion/panel/SettingsDrawer';
import { DEFAULT_CONFIG, toPublicConfig } from '../../shared/config';
import type { TokenDanceAuthStatus } from '../../shared/auth';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };

/** Real React DOM, with protocol-only mocks. Never opens a browser or calls TokenDance. */
export async function authSettingsTest() {
  const previous = window.companion, host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), writes: unknown[] = []; let starts = 0, cancels = 0;
  let status: TokenDanceAuthStatus = { phase: 'idle', message: '' };
  window.companion = {
    ...previous,
    getTokenDanceAuth: async () => ({ ...status }),
    beginTokenDanceAuth: async () => { starts++; return (status = { phase: 'waiting', message: 'fixture-waiting' }); },
    cancelTokenDanceAuth: async () => { cancels++; return (status = { phase: 'cancelled', message: 'fixture-cancelled' }); },
  };
  const button = (label: string, scope: Element = host) => {
    const found = [...scope.querySelectorAll('button')].find(b => b.textContent === label); if (!found) throw new Error(`Missing button: ${label}`); return found;
  };
  const click = (b: HTMLButtonElement) => flushSync(() => b.click());
  try {
    flushSync(() => root.render(createElement(SettingsDrawer, { open: true, target: { group: 'agent', nonce: 1 }, onGroup: () => {}, onClose: () => {}, config: toPublicConfig(DEFAULT_CONFIG), setConfig: async p => { writes.push(p); } })));
    await sleep(30);
    check(starts === 0 && writes.length === 0, 'settings mount started authorization or saved credentials');
    check(host.textContent?.includes('S256 PKCE') && host.textContent?.includes('尚未使用 Keychain'), 'security instructions missing');
    click(button('使用 TokenDance 授权')); await sleep(30);
    check(starts === 1 && button('授权进行中…').disabled, 'authorization button not gated');
    click(button('取消授权')); await sleep(30); check(cancels === 1, 'cancel not forwarded');
    const manual = host.querySelector('[data-field="agent.manualKey"]')!;
    click(button('填写', manual));
    let input = manual.querySelector('input')!; input.value = 'fixture-transient-key';
    flushSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await sleep(20); check(writes.length === 0, 'blur saved an unconfirmed key');
    click(button('取消', manual)); check(!manual.querySelector('input'), 'cancel left secret input mounted');
    click(button('填写', manual)); input = manual.querySelector('input')!; input.value = 'fixture-explicit-key';
    click(button('保存', manual)); await sleep(30);
    check(JSON.stringify(writes) === JSON.stringify([{ agent: { apiKey: 'fixture-explicit-key' } }]), 'manual save not explicit / single');
    check(!manual.querySelector('input') && !host.innerHTML.includes('fixture-explicit-key'), 'saved key echoed in DOM');
  } finally { flushSync(() => root.unmount()); host.remove(); window.companion = previous; }
}
