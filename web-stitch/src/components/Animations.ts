import type { TargetAndTransition, Transition } from 'framer-motion';
import type { ExpressionDefinition, MascotExpression } from './Types';

export const faceTransition: Transition = { duration: .26, ease: [.22, 1, .36, 1] };
export const softSpring: Transition = { type: 'spring', stiffness: 180, damping: 18, mass: .8 };

export function robotAnimation(expression: MascotExpression, floating: boolean, reduced: boolean): TargetAndTransition {
  if (reduced) return { x: 0, y: 0, scale: 1, rotate: 0 };
  if (expression === 'error') return { x: [0, -2.5, 2.5, -1.5, 1.5, 0], transition: { duration: .42 } };
  if (expression === 'success' || expression === 'celebrating') {
    return { y: [0, -8, 0], scaleY: [1, .97, 1], scaleX: [1, 1.025, 1], transition: { duration: .62, ease: 'easeOut' } };
  }
  return floating
    ? { y: [0, -2.2, 0], transition: { duration: 4.8, repeat: Infinity, ease: 'easeInOut' } }
    : { x: 0, y: 0, scale: 1, rotate: 0 };
}

export function bodyAnimation(definition: ExpressionDefinition, speaking: boolean, reduced: boolean): TargetAndTransition {
  const { bounce, tilt, squash } = definition.body;
  if (reduced) return { y: bounce * -.2, rotate: tilt, scaleX: 1 + squash, scaleY: 1 - squash };
  if (speaking) {
    return {
      y: [0, -1.8 - bounce * .18, 0], rotate: tilt,
      scaleX: [1 + squash, 1 + squash + .008, 1 + squash],
      scaleY: [1 - squash, .985 - squash, 1 - squash],
      transition: { duration: .52, repeat: Infinity, ease: 'easeInOut' },
    };
  }
  return {
    y: bounce * -.28, rotate: tilt,
    scaleX: [1 + squash, 1.006 + squash, 1 + squash],
    scaleY: [1 - squash, .994 - squash, 1 - squash],
    transition: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' },
  };
}

export function headAnimation(expression: MascotExpression, thinking: boolean, reduced: boolean): TargetAndTransition {
  if (reduced) return { rotate: expression === 'listening' ? 3 : 0, y: 0 };
  if (thinking) return { rotate: [-1.5, 1.5, -1.5], y: [0, -1, 0], transition: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' } };
  if (expression === 'listening') return { rotate: 3.5, y: -1, transition: softSpring };
  return { rotate: 0, y: 0, transition: softSpring };
}

export function antennaAnimation(thinking: boolean, reduced: boolean): TargetAndTransition {
  if (reduced) return { rotate: 0, y: 0 };
  return thinking
    ? { rotate: [-3, 4, -2, 0], transition: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' } }
    : { y: [0, -1.4, 0], rotate: [0, 1.2, 0], transition: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } };
}

export function waveAnimation(waving: boolean, reduced: boolean): TargetAndTransition {
  if (!waving || reduced) return { rotate: 0 };
  return { rotate: [0, -28, -18, -30, -17, -28, 0], transition: { duration: 1.45, repeat: Infinity, repeatDelay: 1.8, ease: 'easeInOut' } };
}
