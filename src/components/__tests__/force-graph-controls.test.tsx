import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForceGraph3D } from "@/components/force-graph-3d";
import { STORAGE_KEY, resetAgentStore } from "@/lib/agent-store";
import { DIM_LINK_COLOR, DIM_NODE_COLOR, type GraphControls } from "@/lib/graph-highlight";

/**
 * The chatbox's hook into ForceGraph3D (`controls`): the drawn data, flying to
 * a node, and re-styling nodes and links for a highlight. The library is a
 * stand-in that keeps the accessors it was handed.
 */

type Accessor = (item: object) => unknown;
type Fake = {
  data: { nodes: { id: string; x?: number; y?: number; z?: number }[]; links: object[] };
  accessors: Record<string, Accessor>;
  sets: Record<string, number>;
  flights: { to: { x: number; y: number; z: number }; ms?: number }[];
};
const fakes = vi.hoisted(() => ({ list: [] as Fake[] }));

vi.mock("3d-force-graph", async () => {
  const THREE = await import("three");
  class FakeGraph {
    constructor(element: HTMLElement) {
      element.appendChild(document.createElement("canvas"));
      const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100000);
      camera.position.set(0, 0, 1000);
      const orbit = { enabled: true, target: new THREE.Vector3() };
      const fake: Fake = { data: { nodes: [], links: [] }, accessors: {}, sets: {}, flights: [] };
      fakes.list.push(fake);
      const proxy: object = new Proxy(this, {
        get: (_target, prop: string) => {
          switch (prop) {
            case "_destructor":
              return () => {};
            case "renderer":
              return () => ({ forceContextLoss() {}, domElement: document.createElement("canvas") });
            case "scene":
              return () => new THREE.Scene();
            case "camera":
              return () => camera;
            case "controls":
              return () => orbit;
            case "graphData":
              return (data?: Fake["data"]) => {
                if (data === undefined) return fake.data;
                data.nodes.forEach((node, i) => Object.assign(node, { x: i * 5000, y: 0, z: 0 }));
                fake.data = data;
                return proxy;
              };
            case "cameraPosition":
              return (to: Fake["flights"][number]["to"], _at: unknown, ms?: number) => {
                fake.flights.push({ to, ms });
                return proxy;
              };
            default:
              return (value?: unknown) => {
                if (value === undefined) return fake.accessors[prop];
                if (typeof value === "function") fake.accessors[prop] = value as Accessor;
                fake.sets[prop] = (fake.sets[prop] ?? 0) + 1;
                return proxy;
              };
          }
        },
      });
      return proxy;
    }
  }
  return { default: FakeGraph };
});

function seed() {
  resetAgentStore();
  const tools = [
    {
      id: "s1",
      name: "Tavily",
      query: "solar",
      status: "done",
      sources: [
        { title: "X", url: "https://x.org/" },
        { title: "Y", url: "https://y.org/" },
      ],
    },
  ];
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      chats: [{ id: "a", title: "Chat A", createdAt: 1, updatedAt: 1 }],
      messages: { a: [{ id: "m1", role: "assistant", content: "", createdAt: 1, tools }] },
      activeChatId: null,
      groups: [],
    }),
  );
}

afterEach(() => {
  cleanup();
  resetAgentStore();
  fakes.list = [];
});

describe("ForceGraph3D controls", () => {
  it("exposes the drawn graph, flies to a node, and dims all but a highlight", async () => {
    seed();
    const controls = createRef<GraphControls | null>() as { current: GraphControls | null };
    const view = render(<ForceGraph3D controls={controls} />);
    await waitFor(() => expect(controls.current).not.toBeNull());
    const fake = fakes.list[0];
    const host = view.container.querySelector<HTMLElement>("[data-force-graph]")!;

    const graph = controls.current!.getGraph();
    expect(graph.nodes.map((n) => n.id)).toEqual(fake.data.nodes.map((n) => n.id));

    expect(controls.current!.focusNode("nope")).toBe(false);
    expect(controls.current!.focusNode("page:x.org")).toBe(true);
    expect(fake.flights).toHaveLength(1);

    const nodeColor = () => fake.data.nodes.map((n) => fake.accessors.nodeColor(n));
    expect(nodeColor()).not.toContain(DIM_NODE_COLOR);
    const sets = fake.sets.nodeColor;
    controls.current!.setHighlight(["page:x.org", "page:y.org"]);
    expect(fake.sets.nodeColor).toBe(sets + 1); // re-handed, so the library re-styles
    expect(host.dataset.highlight).toBe("2");
    const colors = Object.fromEntries(fake.data.nodes.map((n) => [n.id, fake.accessors.nodeColor(n)]));
    expect(colors["page:x.org"]).not.toBe(DIM_NODE_COLOR);
    expect(colors["chat:a"]).toBe(DIM_NODE_COLOR);
    for (const link of fake.data.links) expect(fake.accessors.linkColor(link)).toBe(DIM_LINK_COLOR);

    controls.current!.setHighlight(null);
    expect(nodeColor()).not.toContain(DIM_NODE_COLOR);
    expect(host.dataset.highlight).toBeUndefined();

    view.unmount();
    expect(controls.current).toBeNull();
  });
});
