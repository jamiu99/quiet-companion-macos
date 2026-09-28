import { useEffect, useState } from 'react';
import type { AppState } from '@shared/events';
import type { PublicConfig } from '@shared/config';
import { installMock, mockScenario } from './mock';

// Dev-only: `?mock=live|idle|running|empty|connecting|error` swaps in fake data (see ./mock.ts).
// `import.meta.env.DEV` is a compile-time constant, so the mock module is tree-shaken out of production builds.
const mock = import.meta.env.DEV ? mockScenario() : null;
if (mock) installMock(mock);

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => { void window.companion.getState().then(setState); return window.companion.onState(setState); }, []);
  return state;
}
export function useConfig() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => { void window.companion.getConfig().then(setConfig); return window.companion.onConfig(setConfig); }, []);
  // The main process broadcasts the new config right after applying it; using the invoke result too rendered twice.
  return [config, async (patch: Record<string, unknown>) => { await window.companion.setConfig(patch); }] as const;
}
