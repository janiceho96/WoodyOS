import { describe, expect, it } from 'vitest';
import { expressions, mascotExpressionNames } from '../web-stitch/src/components/Expressions';

const required = [
  'neutral', 'happy', 'veryHappy', 'laughing', 'excited', 'curious', 'thinking', 'confused', 'surprised',
  'sleepy', 'worried', 'sad', 'angry', 'determined', 'proud', 'embarrassed', 'love', 'shy', 'loading',
  'typing', 'listening', 'processing', 'error', 'offline', 'success', 'celebrating',
];

describe('Woody mascot expressions', () => {
  it('provides every required expression from one registry', () => {
    expect(mascotExpressionNames).toEqual(required);
  });

  it('defines independently movable facial features and restrained body motion', () => {
    for (const expression of Object.values(expressions)) {
      expect(expression.eyes.left.shape).toBeTruthy();
      expect(expression.eyes.right.shape).toBeTruthy();
      expect(expression.eyebrows.left.opacity).toBeGreaterThanOrEqual(0);
      expect(expression.eyebrows.right.opacity).toBeLessThanOrEqual(1);
      expect(expression.mouth.shape).toBeTruthy();
      expect(Math.abs(expression.body.bounce)).toBeLessThanOrEqual(5);
      expect(Math.abs(expression.body.tilt)).toBeLessThanOrEqual(3);
    }
  });
});
