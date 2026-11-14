import { render } from "@testing-library/react";
import { forwardRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

/* Motion's projection data is intentionally not written to the DOM. Expose the
   two props that matter to this regression while leaving every other motion
   element on the real implementation. */
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  type DivProps = ComponentProps<"div"> & {
    layout?: boolean | string;
    layoutAnchor?: { x: number; y: number } | false;
    layoutId?: string;
    transition?: unknown;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
  };
  const Div = forwardRef<HTMLDivElement, DivProps>(function Div(
    {
      layout,
      layoutAnchor,
      layoutId,
      transition: _transition,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      ...props
    },
    ref,
  ) {
    return (
      <div
        {...props}
        ref={ref}
        data-motion-layout={layout}
        data-motion-layout-anchor={
          layoutAnchor === false ? "false" : JSON.stringify(layoutAnchor)
        }
        data-motion-layout-id={layoutId}
      />
    );
  });

  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get(target, property, receiver) {
        return property === "div" ? Div : Reflect.get(target, property, receiver);
      },
    }),
  };
});

import { AiComposer } from "@/components/ai/composer";

describe("AiComposer projection", () => {
  it("counter-projects the home ribbon without scaling or off-centre drift", () => {
    render(
      <AiComposer
        value=""
        onValueChange={() => undefined}
        onSubmit={() => undefined}
        docked={false}
        transition={{ duration: 0 }}
      />,
    );

    const crisp = document.querySelector('[data-mark="crisp"]');
    const layer = crisp?.parentElement;

    expect(layer?.dataset.motionLayout).toBe("position");
    expect(layer?.dataset.motionLayoutAnchor).toBe('{"x":0.5,"y":0}');
  });
});
