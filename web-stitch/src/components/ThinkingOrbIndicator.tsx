import { lazy, Suspense } from 'react';
import type { OrbState } from 'thinking-orbs';

const ThinkingOrb = lazy(async () => {
  const module = await import('thinking-orbs');
  return { default: module.ThinkingOrb };
});

export type ThinkingOrbState = OrbState;

export function ThinkingOrbIndicator({ state, size, label, decorative = false }: { state: OrbState; size: 20 | 64; label: string; decorative?: boolean }) {
  return <Suspense fallback={<span className={`thinking-orb-fallback size-${size}`} aria-hidden="true"/>}>
    <ThinkingOrb state={state} size={size} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}/>
  </Suspense>;
}
