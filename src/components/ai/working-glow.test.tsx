import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiPane } from "@/components/ai/pane";
import { WorkingGlow } from "@/components/ai/working-glow";
import { __resetAgentStore } from "@/lib/agent-store";
import { WORKING } from "@/lib/motion-tokens";

const glow = () => document.querySelector('[data-ai="working-glow"]') as HTMLElement | null;

/* Motion reads the media query once per process and caches it, so a stubbed
   `matchMedia` cannot flip it between tests: the app's own hook is the seam. */
const motionPref = vi.hoisted(() => ({ reduce: false }));
vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => motionPref.reduce,
}));
const prefersReducedMotion = (reduce: boolean) => {
  motionPref.reduce = reduce;
};

describe("WorkingGlow", () => {
  beforeEach(() => {
    __resetAgentStore();
    prefersReducedMotion(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lights the card only while a reply is arriving, and fades out after", async () => {
    // hold the route open so the reply stays in flight until released
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      new Promise((resolve) => {
        release = () =>
          resolve(new Response(new TextEncoder().encode("event: done\ndata: {}\n\n"), { status: 200 }));
      }),
    ));

    render(<AiPane />);
    const card = document.querySelector('[data-region="ai-pane"]') as HTMLElement;
    // the overlay is positioned against the card, so the card must be its box
    expect(card.className).toContain("relative");
    expect(glow()).toBeNull();

    const field = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "hello" } });
    fireEvent.keyDown(field, { key: "Enter" });

    const el = await waitFor(() => {
      if (!glow()) throw new Error("no glow yet");
      return glow() as HTMLElement;
    });
    // over the card, out of flow, never in the way of a click
    expect(el.parentElement).toBe(card);
    expect(el.className).toContain("absolute");
    expect(el.className).toContain("inset-0");
    expect(el.className).toContain("pointer-events-none");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    // the lap and the breath run on the calibrated durations
    const sweep = el.querySelector('[data-ai="working-sweep"]') as HTMLElement;
    const breath = el.querySelector('[data-ai="working-breath"]') as HTMLElement;
    expect(sweep.className).toContain("animate-spin");
    expect(sweep.style.animationDuration).toBe(`${WORKING.sweep}s`);
    expect(breath.className).toContain("animate-pulse");
    expect(breath.style.animationDuration).toBe(`${WORKING.breath}s`);
    // and nothing in it is red, the colour reserved for contradictions
    expect(el.innerHTML.toLowerCase()).not.toMatch(/dc2626|220,\s*38,\s*38/);

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // gone once the exit fade has run
    await waitFor(() => expect(glow()).toBeNull(), { timeout: WORKING.fade * 1000 + 700 });
  });

  it("is a static accent ring under reduced motion", () => {
    prefersReducedMotion(true);
    render(<WorkingGlow working />);
    const el = glow() as HTMLElement;
    // the ring stays; the travelling light is hidden and the breath held still
    expect(el.querySelector('[data-ai="working-ring"]')).not.toBeNull();
    const sweep = el.querySelector('[data-ai="working-sweep"]') as HTMLElement;
    const breath = el.querySelector('[data-ai="working-breath"]') as HTMLElement;
    expect(sweep.className).toContain("motion-reduce:hidden");
    expect(breath.className).toContain("motion-reduce:animate-none");
    expect(breath.className).toContain("motion-reduce:opacity-0");
  });

  it("leaves at once under reduced motion", async () => {
    prefersReducedMotion(true);
    const { rerender } = render(<WorkingGlow working />);
    expect(glow()).not.toBeNull();
    rerender(<WorkingGlow working={false} />);
    // no fade to wait out: well inside the 300ms the animated exit takes
    await waitFor(() => expect(glow()).toBeNull(), { timeout: 150 });
  });

  it("is not there when nothing is working", () => {
    render(<WorkingGlow working={false} />);
    expect(glow()).toBeNull();
  });
});
