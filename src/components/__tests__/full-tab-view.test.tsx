import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PLACEHOLDER_NODE_COUNT, placeholderGraph } from "@/components/force-graph-3d";
import { Shell } from "@/components/shell";
import { SIDE_PANEL_INSET, SIDE_TAB_LABELS } from "@/components/side-tabs";
import { defaultView } from "@/lib/navigation";

/* Instant motion: the tests pin what opens and closes, not the frames between. */
vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => true,
}));

/* jsdom has no WebGL: a chainable stand-in that records mounts and teardowns */
const graphs = vi.hoisted(() => ({
  mounted: [] as HTMLElement[],
  destroyed: 0,
  data: null as unknown,
}));
vi.mock("3d-force-graph", () => {
  class FakeGraph {
    constructor(element: HTMLElement) {
      graphs.mounted.push(element);
      element.appendChild(document.createElement("canvas"));
      const proxy: object = new Proxy(this, {
        get: (_target, prop) => {
          if (prop === "_destructor") return () => void graphs.destroyed++;
          if (prop === "renderer") return () => ({ forceContextLoss() {} });
          if (prop === "graphData")
            return (data?: unknown) => {
              if (data === undefined) return graphs.data;
              graphs.data = data;
              return proxy;
            };
          return () => proxy;
        },
      });
      return proxy;
    }
  }
  return { default: FakeGraph };
});

beforeEach(() => {
  graphs.mounted = [];
  graphs.destroyed = 0;
  graphs.data = null;
});

const renderShell = () => render(<Shell view={defaultView()} content={<div>chat</div>} />);
const tab = (name: string) => screen.getByRole("button", { name });
const column = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>("[data-full-view-covers]")[1];

describe("full-width tab views", () => {
  it.each(["World Labs", "Force graph", "Visualize"])(
    "opens %s full width; Back closes it and restores the tabs",
    async (name) => {
      const { container } = renderShell();
      const opener = tab(name);

      fireEvent.click(opener);

      const view = screen.getByRole("region", { name });
      expect(view.hasAttribute("data-full-tab-view")).toBe(true);
      // not the side panel, and the chat keeps its width
      expect(container.querySelector("[data-side-tab-panel]")).toBeNull();
      expect(column(container).style.getPropertyValue(SIDE_PANEL_INSET)).toBe("0px");
      // Back is focused; everything under the page, tabs included, is inert
      const back = screen.getByRole("button", { name: "Back" });
      expect(document.activeElement).toBe(back);
      for (const covered of container.querySelectorAll<HTMLElement>("[data-full-view-covers]"))
        expect(covered.inert).toBe(true);

      fireEvent.click(back);

      await waitFor(() => expect(screen.queryByRole("region", { name })).toBeNull());
      for (const covered of container.querySelectorAll<HTMLElement>("[data-full-view-covers]"))
        expect(covered.inert).toBe(false);
      expect(document.activeElement).toBe(tab(name));
      expect(
        [...container.querySelectorAll("[data-side-tab]")].map((t) => t.textContent),
      ).toEqual([...SIDE_TAB_LABELS]);
    },
  );

  it("closes on Escape", async () => {
    renderShell();
    fireEvent.click(tab("World Labs"));
    expect(screen.getByRole("region", { name: "World Labs" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("region", { name: "World Labs" })).toBeNull());
    expect(document.activeElement).toBe(tab("World Labs"));
  });

  it.each(["Knowledge base", "References"])("keeps %s as a side panel", (name) => {
    const { container } = renderShell();

    fireEvent.click(tab(name));

    expect(container.querySelector(`[data-side-tab-panel="${name}"]`)).not.toBeNull();
    expect(container.querySelector("[data-full-tab-view]")).toBeNull();
  });

  it("gives Visualize a blank canvas: Back only, no graph", async () => {
    renderShell();
    fireEvent.click(tab("Visualize"));
    const view = screen.getByRole("region", { name: "Visualize" });
    await act(async () => {});
    expect(graphs.mounted).toHaveLength(0);
    expect(view.querySelectorAll("*")).toHaveLength(view.querySelectorAll("button, button *").length);
  });

  it("mounts the 3D graph only in the Force graph view, and destroys it on close", async () => {
    renderShell();

    fireEvent.click(tab("World Labs"));
    await act(async () => {});
    expect(graphs.mounted).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());

    fireEvent.click(tab("Force graph"));
    const view = screen.getByRole("region", { name: "Force graph" });
    await waitFor(() => expect(graphs.mounted).toHaveLength(1));
    const host = view.querySelector("[data-force-graph]");
    expect(graphs.mounted[0]).toBe(host);
    expect(host?.querySelector("canvas")).not.toBeNull();
    expect((graphs.data as { nodes: unknown[] }).nodes).toHaveLength(PLACEHOLDER_NODE_COUNT);
    expect(host?.getAttribute("data-nodes")).toBe(String(PLACEHOLDER_NODE_COUNT));

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(graphs.destroyed).toBe(1));
    expect(document.querySelector("[data-force-graph]")).toBeNull();
  });

  it("builds the same placeholder tree every time", () => {
    const a = placeholderGraph();
    expect(a).toEqual(placeholderGraph());
    expect(a.nodes).toHaveLength(PLACEHOLDER_NODE_COUNT);
    expect(a.links).toHaveLength(PLACEHOLDER_NODE_COUNT - 1);
  });
});
