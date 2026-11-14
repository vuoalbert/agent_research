"use client";

import { cn } from "cn";
import {
  type ComponentPropsWithRef,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type ScrollEdges = {
  top: boolean;
  bottom: boolean;
};

type ScrollBlurViewportProps = Omit<
  ComponentPropsWithRef<"div">,
  "children" | "className" | "ref"
> & {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

export interface ScrollBlurProps extends ComponentPropsWithRef<"div"> {
  children: ReactNode;
  viewportClassName?: string;
  viewportLabel?: string;
  viewportProps?: ScrollBlurViewportProps;
}

/**
 * Native scroll viewport with scroll-aware edge blur.
 *
 * The metric and ResizeObserver lifecycle follows beUI's contained
 * MessageScroller pattern. The edge treatment intentionally stays to one
 * masked backdrop-filter layer per visible edge to keep scrolling cheap.
 */
export function ScrollBlur({
  children,
  className,
  viewportClassName,
  viewportLabel,
  viewportProps,
  ...props
}: ScrollBlurProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>({
    top: false,
    bottom: false,
  });
  const { onScroll: onViewportScroll, ...restViewportProps } =
    viewportProps ?? {};

  const updateEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const maxScrollTop = Math.max(
      0,
      viewport.scrollHeight - viewport.clientHeight,
    );
    const next = {
      top: viewport.scrollTop > 1,
      bottom: viewport.scrollTop < maxScrollTop - 1,
    };

    setEdges((current) =>
      current.top === next.top && current.bottom === next.bottom
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    updateEdges();
    const frame = window.requestAnimationFrame(updateEdges);
    window.addEventListener("resize", updateEdges);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateEdges);
    resizeObserver?.observe(viewport);

    const content = viewport.firstElementChild;
    if (content) {
      resizeObserver?.observe(content);
    }

    const mutationObserver =
      content && typeof MutationObserver !== "undefined"
        ? new MutationObserver(updateEdges)
        : null;
    mutationObserver?.observe(content!, {
      childList: true,
      subtree: true,
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateEdges);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [updateEdges]);

  return (
    <div
      data-slot="scroll-blur"
      className={cn("relative isolate min-h-0 overflow-hidden", className)}
      {...props}
    >
      <div
        {...restViewportProps}
        ref={viewportRef}
        data-slot="scroll-blur-viewport"
        aria-label={viewportLabel}
        tabIndex={0}
        onScroll={(event) => {
          updateEdges();
          onViewportScroll?.(event);
        }}
        className={cn("relative z-0 h-full min-h-0", viewportClassName)}
      >
        {children}
      </div>

      {edges.top ? (
        <div
          aria-hidden="true"
          data-scroll-blur-edge="top"
          className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] bg-[linear-gradient(to_bottom,rgba(255,255,255,0.78),rgba(255,255,255,0))] backdrop-blur-[2px] [mask-image:linear-gradient(to_bottom,black,transparent)] [-webkit-mask-image:linear-gradient(to_bottom,black,transparent)]"
        />
      ) : null}

      {edges.bottom ? (
        <div
          aria-hidden="true"
          data-scroll-blur-edge="bottom"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[2px] bg-[linear-gradient(to_top,rgba(255,255,255,0.78),rgba(255,255,255,0))] backdrop-blur-[2px] [mask-image:linear-gradient(to_top,black,transparent)] [-webkit-mask-image:linear-gradient(to_top,black,transparent)]"
        />
      ) : null}
    </div>
  );
}
