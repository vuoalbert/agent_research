import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_TEXT, ForceGraph3D } from "@/components/force-graph-3d";
import { IFRAME_SANDBOX, PAGE_FAR, __clearEmbedAnswers } from "@/components/graph-page-panel";
import { STORAGE_KEY, getAgentState, resetAgentStore, sendMessage, type AgentState } from "@/lib/agent-store";
import { buildResearchGraph } from "@/lib/research-graph";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => motion.reduced,
}));

type FakeNode = { id: string; kind: string; url?: string; x?: number; y?: number; z?: number };
type Fake = {
  element: HTMLElement;
  scene: import("three").Scene;
  camera: import("three").PerspectiveCamera;
  data: { nodes: FakeNode[]; links: unknown[] };
  setData: number;
  click?: (node: FakeNode) => void;
  flights: { to: { x: number; y: number; z: number }; ms?: number }[];
  destroyed: boolean;
};
const fakes = vi.hoisted(() => ({ list: [] as Fake[] }));

/* jsdom has no WebGL: a stand-in with a real scene and camera, which renders
   its extra (CSS3D) renderers every frame like the library does */
vi.mock("3d-force-graph", async () => {
  const THREE = await import("three");
  class FakeGraph {
    constructor(element: HTMLElement, options: { extraRenderers?: { domElement: HTMLElement; render: (s: unknown, c: unknown) => void; setSize: (w: number, h: number) => void }[] } = {}) {
      const canvas = document.createElement("canvas");
      element.appendChild(canvas);
      const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100000);
      camera.position.set(0, 0, 1000);
      camera.updateProjectionMatrix();
      const fake: Fake = { element, scene: new THREE.Scene(), camera, data: { nodes: [], links: [] }, setData: 0, flights: [], destroyed: false };
      fakes.list.push(fake);
      const renderers = options.extraRenderers ?? [];
      for (const r of renderers) {
        r.setSize(800, 500);
        element.appendChild(r.domElement);
      }
      let frame = requestAnimationFrame(function loop() {
        frame = requestAnimationFrame(loop);
        camera.updateMatrixWorld();
        for (const r of renderers) r.render(fake.scene, camera);
      });
      const proxy: object = new Proxy(this, {
        get: (_target, prop) => {
          switch (prop) {
            case "_destructor":
              return () => {
                fake.destroyed = true;
                cancelAnimationFrame(frame);
              };
            case "renderer":
              return () => ({ forceContextLoss() {}, domElement: canvas });
            case "scene":
              return () => fake.scene;
            case "camera":
              return () => camera;
            case "graphData":
              return (data?: Fake["data"]) => {
                if (data === undefined) return fake.data;
                /* lay nodes out 400 apart on x, as if the simulation had run */
                data.nodes.forEach((node, i) => {
                  node.x ??= i * 400;
                  node.y ??= 0;
                  node.z ??= 0;
                });
                fake.data = data;
                fake.setData++;
                return proxy;
              };
            case "onNodeClick":
              return (handler: Fake["click"]) => {
                fake.click = handler;
                return proxy;
              };
            case "cameraPosition":
              return (to: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }, ms?: number) => {
                fake.flights.push({ to, ms });
                camera.position.set(to.x, to.y, to.z);
                camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
                camera.updateMatrixWorld();
                return proxy;
              };
            default:
              return () => proxy;
          }
        },
      });
      return proxy;
    }
  }
  return { default: FakeGraph };
});

const fetchMock = vi.fn<typeof fetch>();

const BLOCKED = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
/** two chats that share https://example.com */
function seededState(): Omit<AgentState, "streaming"> {
  const tools = (id: string, urls: string[]) => [
    { id: `${id}-s`, name: "Tavily", query: `query ${id}`, status: "done", sources: urls.map((url) => ({ title: `Title ${url}`, url })) },
  ];
  return {
    chats: [
      { id: "a", title: "Chat A", createdAt: 1, updatedAt: 1 },
      { id: "b", title: "Chat B", createdAt: 2, updatedAt: 2 },
    ],
    messages: {
      a: [{ id: "a1", role: "assistant", content: "", createdAt: 1, tools: tools("a", ["https://example.com/", BLOCKED]) as never }],
      b: [{ id: "b1", role: "assistant", content: "", createdAt: 2, tools: tools("b", ["https://www.example.com"]) as never }],
    },
    activeChatId: null,
    groups: [],
  };
}

function seed(state = seededState()) {
  resetAgentStore();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

beforeEach(() => {
  fakes.list = [];
  motion.reduced = false;
  __clearEmbedAnswers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/embed-check") {
      const target = url.searchParams.get("url") ?? "";
      return Response.json(
        target.includes("youtube") ? { embeddable: false, reason: "The site's X-Frame-Options (SAMEORIGIN) forbids embedding" } : { embeddable: true },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetAgentStore();
});

const mount = async () => {
  const view = render(<div style={{ width: 800, height: 500 }}><ForceGraph3D className="absolute inset-0" /></div>);
  await waitFor(() => expect(fakes.list).toHaveLength(1));
  const fake = fakes.list[0];
  await waitFor(() => expect(fake.setData).toBeGreaterThan(0));
  return { ...view, fake, host: view.container.querySelector<HTMLElement>("[data-force-graph]")! };
};
const node = (fake: Fake, id: string) => fake.data.nodes.find((n) => n.id === id)!;
const frames = (n = 3) => act(() => new Promise<void>((resolve) => {
  let left = n;
  const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}));

describe("ForceGraph3D", () => {
  it("shows the empty state, and an empty graph, with no research", async () => {
    resetAgentStore();
    const { fake, container, host } = await mount();
    expect(fake.data.nodes).toHaveLength(0);
    expect(host.dataset.nodes).toBe("0");
    expect(container.textContent).toContain(EMPTY_TEXT);
  });

  it("graphs every chat's research, one node for a page both chats found", async () => {
    seed();
    const { fake, container, host } = await mount();
    const expected = buildResearchGraph(seededState().chats, seededState().messages);
    expect(fake.data.nodes.map((n) => n.id)).toEqual(expected.nodes.map((n) => n.id));
    expect(fake.data.links).toHaveLength(expected.links.length);
    expect(host.dataset.nodes).toBe(String(expected.nodes.length));
    expect(host.dataset.links).toBe(String(expected.links.length));
    expect(fake.data.nodes.filter((n) => n.id === "page:example.com")).toHaveLength(1);
    expect(container.textContent).not.toContain(EMPTY_TEXT);
    // 2 chats, 2 searches, 2 pages
    expect(expected.nodes).toHaveLength(6);
  });

  it("grows live as a reply's tool events arrive, keeping placed nodes", async () => {
    seed();
    const { fake } = await mount();
    const placed = node(fake, "page:example.com");
    const frames = [
      `event: tool\ndata: ${JSON.stringify({ id: "t1", name: "Tavily", query: "more", status: "running" })}\n\n`,
      `event: tool\ndata: ${JSON.stringify({ id: "t1", status: "done", sources: [{ title: "New", url: "https://new.org/x" }] })}\n\n`,
      "event: done\ndata: {}\n\n",
    ];
    fetchMock.mockImplementationOnce(async () =>
      new Response(new ReadableStream({
        start(controller) {
          for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
          controller.close();
        },
      })),
    );
    await act(async () => sendMessage("a", "dig deeper"));
    await waitFor(() => expect(fake.data.nodes.some((n) => n.id === "page:new.org/x")).toBe(true));
    expect(node(fake, "page:example.com")).toBe(placed);
    expect(getAgentState().streaming).toEqual([]);
  });

  it("opens the live page in an iframe when the camera nears it, and unmounts it on the way out", async () => {
    seed();
    const { fake, host } = await mount();
    const page = node(fake, "page:example.com");

    act(() => fake.click!(page));
    expect(fake.flights.at(-1)?.ms).toBe(800);
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(1));
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://example.com/");
    expect(frame.getAttribute("sandbox")).toBe(IFRAME_SANDBOX);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(host.dataset.page).toBe("https://example.com/");
    // it sits in the CSS3D layer, which lets the rest of the view through to the canvas
    const layer = host.querySelector<HTMLElement>("[data-css3d]")!;
    expect(layer.contains(frame)).toBe(true);
    expect(layer.style.pointerEvents).toBe("none");
    expect(host.querySelector<HTMLElement>("[data-graph-panel]")!.style.pointerEvents).toBe("auto");

    // away past PAGE_FAR: the panel and its iframe leave the DOM
    act(() => fake.camera.position.set(page.x!, page.y!, page.z! + PAGE_FAR + 400));
    await waitFor(() => expect(host.querySelector("iframe")).toBeNull());
    expect(host.querySelector("[data-graph-panel]")).toBeNull();
    expect(fake.scene.children.some((c) => "isCSS3DObject" in c)).toBe(false);
    expect(host.dataset.page).toBeUndefined();
  });

  it("shows a card that opens the page in a new tab for a site that forbids framing", async () => {
    seed();
    const { fake, host } = await mount();
    act(() => fake.click!(node(fake, "page:youtube.com/watch?v=dQw4w9WgXcQ")));
    await waitFor(() => expect(host.querySelector("[data-panel-card] a")).not.toBeNull());
    expect(host.querySelector("iframe")).toBeNull();
    const panel = host.querySelector<HTMLElement>("[data-graph-panel]")!;
    expect(panel.dataset.state).toBe("card");
    expect(panel.textContent).toContain("X-Frame-Options");
    const open = panel.querySelector<HTMLAnchorElement>("[data-panel-card] a")!;
    expect(open.href).toBe(BLOCKED);
    expect(open.target).toBe("_blank");
    expect(open.rel).toBe("noopener noreferrer");
    expect(panel.querySelector<HTMLImageElement>("img")!.src).toBe(
      "https://www.google.com/s2/favicons?domain=youtube.com&sz=64",
    );
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      `/api/embed-check?url=${encodeURIComponent(BLOCKED)}`,
    ]);

    // the close button flies back out, and the card goes
    act(() => panel.querySelector<HTMLButtonElement>("[data-panel-close]")!.click());
    await waitFor(() => expect(host.querySelector("[data-graph-panel]")).toBeNull());
  });

  it("closing a page backs out past every page, so no neighbour opens instead", async () => {
    seed();
    const { fake, host } = await mount();
    const example = node(fake, "page:example.com");
    const neighbour = node(fake, "page:youtube.com/watch?v=dQw4w9WgXcQ");
    // the neighbour sits right on the way back out
    Object.assign(neighbour, { x: example.x, y: example.y, z: example.z! + 220 });
    act(() => fake.click!(example));
    await waitFor(() => expect(host.querySelector("[data-panel-close]")).not.toBeNull());
    expect(host.dataset.page).toBe("https://example.com/");

    act(() => host.querySelector<HTMLButtonElement>("[data-panel-close]")!.click());
    await frames();
    expect(host.querySelector("[data-graph-panel]")).toBeNull();
    const camera = fake.camera.position;
    for (const n of fake.data.nodes.filter((n) => n.kind === "page"))
      expect(camera.distanceTo({ x: n.x!, y: n.y!, z: n.z! } as never)).toBeGreaterThan(PAGE_FAR);
  });

  it("only ever shows the nearest page", async () => {
    seed();
    const { fake, host } = await mount();
    act(() => fake.click!(node(fake, "page:example.com")));
    await waitFor(() => expect(host.querySelectorAll("[data-graph-panel]")).toHaveLength(1));
    act(() => fake.click!(node(fake, "page:youtube.com/watch?v=dQw4w9WgXcQ")));
    await waitFor(() => expect(host.dataset.page).toBe(BLOCKED));
    await frames();
    expect(host.querySelectorAll("[data-graph-panel]")).toHaveLength(1);
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("moves the camera instantly under reduced motion", async () => {
    motion.reduced = true;
    seed();
    const { fake } = await mount();
    await act(async () => {});
    act(() => fake.click!(node(fake, "chat:a")));
    expect(fake.flights.at(-1)?.ms).toBe(0);
  });

  it("tears down the graph, the page and the CSS3D layer on unmount", async () => {
    seed();
    const { fake, host, unmount } = await mount();
    act(() => fake.click!(node(fake, "page:example.com")));
    await waitFor(() => expect(host.querySelector("iframe")).not.toBeNull());

    unmount();

    expect(fake.destroyed).toBe(true);
    expect(host.childElementCount).toBe(0);
    expect(document.querySelector("iframe")).toBeNull();
    expect(fake.scene.children.some((c) => "isCSS3DObject" in c)).toBe(false);
  });
});
