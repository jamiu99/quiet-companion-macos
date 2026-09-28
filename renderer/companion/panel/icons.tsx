// Tiny inline SVG icon set (SF Symbols-like strokes). No icon library.
// Kept as SVG on purpose: 1.75 px strokes with round caps/joins stay crisp at 14–16 px, unlike rasterised illustrations.
import type { SVGProps } from 'react';

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...props,
});

export const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const CloseIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const ChevronDownIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m6 9 6 6 6-6" /></svg>;
export const ChevronRightIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>;
export const ChevronUpIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m18 15-6-6-6 6" /></svg>;
export const ArrowUpIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
export const StopIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></svg>;
export const PhoneOffIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M10.7 13.3a15 15 0 0 1-2.4-3.1L10 8.5a1 1 0 0 0 .2-1L9 3.9a1 1 0 0 0-1-.7H4.8a1 1 0 0 0-1 1.1A17 17 0 0 0 7 13.2M14.6 15.6c1.4.8 2.9 1.4 4.5 1.8a1 1 0 0 1 .8 1v3.3a1 1 0 0 1-1.1 1 17 17 0 0 1-9-3.7" /><path d="M21 3 3 21" /></svg>;
export const SparkIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>;
export const TerminalIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m4 17 6-6-6-6M12 19h8" /></svg>;
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const TrashIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>;
export const KeyIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="8" cy="15" r="4" /><path d="m10.9 12.1 9.1-9.1M15 5l3 3M18 2l3 3" /></svg>;
export const ImageIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-9 9" /></svg>;
export const CheckIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m5 12 5 5L20 7" /></svg>;
// Pet toolbar icons.
export const MoveIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" /></svg>;
export const ResizeIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M21 3 3 21M21 3h-7M21 3v7M3 21h7M3 21v-7" /></svg>;
/** Closed padlock; `filled` = solid body (locked state on the toolbar). */
export const LockIcon = ({ filled, ...p }: SVGProps<SVGSVGElement> & { filled?: boolean }) => (
  <svg {...base(p)}><rect x="5" y="11" width="14" height="10" rx="2" fill={filled ? 'currentColor' : 'none'} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const PhoneIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>;
export const ChatIcon = ({ filled, ...p }: SVGProps<SVGSVGElement> & { filled?: boolean }) => (
  <svg {...base(p)}><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6.5A8 8 0 1 1 21 12z" fill={filled ? 'currentColor' : 'none'} /></svg>
);
