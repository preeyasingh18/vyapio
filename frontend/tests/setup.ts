import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom lacks several browser APIs the app legitimately uses. Each stub below
 * exists because a component would otherwise throw on mount — they are not
 * shortcuts around testing real behaviour.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// ThemeProvider reads this on first render.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// Framer Motion measures elements on mount.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

global.IntersectionObserver = class {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
} as unknown as typeof IntersectionObserver;

// The offline queue generates idempotency keys with this.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { ...globalThis.crypto, randomUUID: () => `test-${Math.random().toString(36).slice(2)}` },
  });
}

// Counter and Waveform drive animation frames.
global.requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
global.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
