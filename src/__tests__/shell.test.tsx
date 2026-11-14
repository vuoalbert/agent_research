import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Shell } from "@/components/shell";
import { defaultView } from "@/lib/navigation";

/** The app is the AI tab alone: one rail tile, an "AI" sidebar, no other nav. */
describe("Shell", () => {
  it("renders a single AI rail tab, current, linking to /", () => {
    const { container } = render(<Shell view={defaultView()} content={<div />} />);
    const rail = container.querySelector('[data-region="icon-rail"]') as HTMLElement;
    const tabs = within(rail).getAllByRole("link");

    expect(tabs).toHaveLength(1);
    expect(tabs[0].getAttribute("data-rail-tab")).toBe("AI");
    expect(tabs[0].getAttribute("aria-current")).toBe("page");
    expect(tabs[0].getAttribute("href")).toBe("/");
  });

  it("titles the sidebar AI and renders the content card it is given", () => {
    const { container } = render(
      <Shell view={defaultView()} content={<p data-testid="card">pane</p>} />,
    );
    const title = container.querySelector("[data-sidebar-title]");

    expect(title?.textContent).toBe("AI");
    expect(container.querySelector('[data-testid="card"]')).not.toBeNull();
    expect(container.querySelector("[data-nav-row]")).toBeNull();
  });
});
