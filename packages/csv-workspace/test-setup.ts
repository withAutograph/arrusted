import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";

afterEach(() => {
  cleanup();
});

class ResizeObserverStub implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
      this,
    );
  }

  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ResizeObserverStub,
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
}

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return {
      x: 0,
      y: 0,
      width: 1000,
      height: 480,
      top: 0,
      left: 0,
      bottom: 480,
      right: 1000,
      toJSON() {
        return {};
      },
    };
  },
});

for (const property of ["clientHeight", "offsetHeight"] as const) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get() {
      return 480;
    },
  });
}

for (const property of ["clientWidth", "offsetWidth"] as const) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get() {
      return 1000;
    },
  });
}
