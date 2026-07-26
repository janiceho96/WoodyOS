// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  vi.resetModules();
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
});

it('keeps authentication in memory when browser storage is blocked', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Blocked', 'SecurityError'); },
  });

  const { auth } = await import('./api');

  expect(auth.get()).toBe('');
  expect(() => auth.set('memory-only')).not.toThrow();
  expect(auth.get()).toBe('memory-only');
  expect(() => auth.clear()).not.toThrow();
  expect(auth.get()).toBe('');
});

it('keeps the in-memory token when individual storage writes fail', async () => {
  const storage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
    removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  const { auth } = await import('./api');
  auth.set('memory-only');

  expect(auth.get()).toBe('memory-only');
  expect(() => auth.clear()).not.toThrow();
  expect(auth.get()).toBe('');
});
