import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppTransition } from "@/components/app-transition";
import { DURATION, SHIFT, bodyVariants, timing, __resetSwitched } from "@/lib/motion-tokens";

vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => reduceMotion(),
}));

const reduceMotion = vi.fn(() => false);

describe("AppTransition", () => {
  it("swaps the body on the shared move numbers", () => {
    expect(bodyVariants.initial).toEqual({ opacity: 0, y: SHIFT.body });
    expect(bodyVariants.exit).toEqual({ opacity: 0, y: -SHIFT.body });
    expect(timing(DURATION.move, false)).toEqual({
      duration: 0.18,
      ease: [0.32, 0.72, 0, 1],
      delay: 0,
    });
  });

  it("does not animate a first mount — only a real change of route", () => {
    __resetSwitched();
    const { container } = render(
      <AppTransition id="AI" scope="test-pane">
        <p>body</p>
      </AppTransition>,
    );
    // a navigation remounts the tree, so a fresh mount must render at rest
    const body = container.querySelector("[data-app-transition]") as HTMLElement;
    expect(body.style.opacity === "" || body.style.opacity === "1").toBe(true);
    expect(body.style.transform ?? "").not.toContain("8px");
  });

  it("renders the new body immediately under reduced motion", () => {
    __resetSwitched();
    reduceMotion.mockReturnValue(true);
    const { container } = render(
      <AppTransition id="Files:" scope="test-reduced">
        <p>files</p>
      </AppTransition>,
    );
    expect(container.textContent).toBe("files");
    expect(timing(DURATION.move, true)).toEqual({ duration: 0, delay: 0 });
    reduceMotion.mockReturnValue(false);
  });
});
