import type { OrbState } from 'thinking-orbs';

export function thinkingOrbStateForContext(...parts: Array<string | undefined>): OrbState {
  const context = parts.filter(Boolean).join(' ').toLowerCase();
  if (context.includes('search') || context.includes('knowledge') || context.includes('research') || context.includes('browser')) return 'searching';
  if (context.includes('output') || context.includes('result') || context.includes('artifact') || context.includes('compose')) return 'composing';
  if (context.includes('condition') || context.includes('loop') || context.includes('reason') || context.includes('solve')) return 'solving';
  return 'working';
}
