import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Current time, ticking every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

/** Returns a ref for an inline text element plus whether it overflows its container (→ marquee). */
export function useOverflow<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current; const parent = el?.parentElement;
    if (!el || !parent) return;
    const measure = () => setOverflow(Math.max(0, el.scrollWidth - parent.clientWidth));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(parent);
    return () => ro.disconnect();
  }, [dep]);
  return [ref, overflow] as const;
}

/** Keeps a scroll container pinned to the bottom while the user hasn't scrolled up. */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [dep]);
  return ref;
}
