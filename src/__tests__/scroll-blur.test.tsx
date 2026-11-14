import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScrollBlur } from "@/components/ui/scroll-blur";

let resizeCallbacks: ResizeObserverCallback[];
let mutationCallbacks: MutationCallback[];
let animationFrameCallbacks: FrameRequestCallback[];
let resizeObservers: ResizeObserverMock[];
let mutationObservers: MutationObserverMock[];

class ResizeObserverMock implements ResizeObserver {
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
    resizeObservers.push(this);
  }
}

class MutationObserverMock implements MutationObserver {
  readonly observe = vi.fn();
  readonly takeRecords = vi.fn(() => []);
  readonly disconnect = vi.fn();

  constructor(callback: MutationCallback) {
    mutationCallbacks.push(callback);
    mutationObservers.push(this);
  }
}

function defineScrollMetrics(
  viewport: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  Object.defineProperties(viewport, {
    clientHeight: {
      configurable: true,
      get: () => metrics.clientHeight,
    },
    scrollHeight: {
      configurable: true,
      get: () => metrics.scrollHeight,
    },
    scrollTop: {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (value: number) => {
        metrics.scrollTop = value;
      },
    },
  });
}

describe("ScrollBlur", () => {
  beforeEach(() => {
    resizeCallbacks = [];
    mutationCallbacks = [];
    animationFrameCallbacks = [];
    resizeObservers = [];
    mutationObservers = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("MutationObserver", MutationObserverMock);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows each edge only while content continues in that direction", () => {
    const onScroll = vi.fn();
    const { container } = render(
      <ScrollBlur viewportProps={{ onScroll }}>
        <div>Scrollable content</div>
      </ScrollBlur>,
    );
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-blur-viewport"]',
    )!;
    const metrics = { clientHeight: 400, scrollHeight: 1200, scrollTop: 0 };
    defineScrollMetrics(viewport, metrics);

    fireEvent.scroll(viewport);
    expect(container.querySelector('[data-scroll-blur-edge="top"]')).toBeNull();
    expect(
      container.querySelector('[data-scroll-blur-edge="bottom"]'),
    ).not.toBeNull();

    metrics.scrollTop = 240;
    fireEvent.scroll(viewport);
    const topEdge = container.querySelector<HTMLElement>(
      '[data-scroll-blur-edge="top"]',
    )!;
    expect(topEdge).not.toBeNull();
    expect(
      container.querySelector('[data-scroll-blur-edge="bottom"]'),
    ).not.toBeNull();
    expect(topEdge.className).toContain("h-[2px]");
    expect(topEdge.className).toContain(
      "bg-[linear-gradient(to_bottom,rgba(255,255,255,0.78),rgba(255,255,255,0))]",
    );
    expect(topEdge.className).toContain("backdrop-blur-[2px]");
    expect(topEdge.className).toContain("mask-image");
    expect(viewport.className).toContain("relative z-0");
    expect(
      container.querySelector<HTMLElement>('[data-slot="scroll-blur"]')
        ?.className,
    ).toContain("isolate");

    metrics.scrollTop = 800;
    fireEvent.scroll(viewport);
    expect(
      container.querySelector('[data-scroll-blur-edge="top"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-scroll-blur-edge="bottom"]')).toBeNull();
    expect(onScroll).toHaveBeenCalledTimes(3);
  });

  it("recalculates after layout and content changes, then cleans up observers", () => {
    const { container, unmount } = render(
      <ScrollBlur>
        <div data-content="">Content</div>
      </ScrollBlur>,
    );
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-blur-viewport"]',
    )!;
    const content = viewport.firstElementChild!;
    const metrics = { clientHeight: 400, scrollHeight: 900, scrollTop: 0 };
    defineScrollMetrics(viewport, metrics);

    const resizeObserver = resizeObservers[0];
    const mutationObserver = mutationObservers[0];
    expect(resizeObserver.observe).toHaveBeenCalledWith(viewport);
    expect(resizeObserver.observe).toHaveBeenCalledWith(content);
    expect(mutationObserver.observe).toHaveBeenCalledWith(content, {
      childList: true,
      subtree: true,
    });

    act(() => animationFrameCallbacks[0](0));
    expect(
      container.querySelector('[data-scroll-blur-edge="bottom"]'),
    ).not.toBeNull();

    metrics.scrollTop = 500;
    act(() => resizeCallbacks[0]([], resizeObserver));
    expect(
      container.querySelector('[data-scroll-blur-edge="top"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-scroll-blur-edge="bottom"]')).toBeNull();

    metrics.scrollHeight = 1200;
    act(() => mutationCallbacks[0]([], mutationObserver));
    expect(
      container.querySelector('[data-scroll-blur-edge="bottom"]'),
    ).not.toBeNull();

    unmount();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(mutationObserver.disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  });
});
