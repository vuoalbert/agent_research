import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_TEXT, ForceGraph3D, LINK_STYLE } from "@/components/force-graph-3d";
import { IFRAME_SANDBOX, MAX_PAGES, PAGE_FAR, __clearEmbedAnswers } from "@/components/graph-page-panel";
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
  controls: { enabled: boolean; target?: import("three").Vector3 };
  pointer: boolean;
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
      const fake: Fake = { element, scene: new THREE.Scene(), camera, data: { nodes: [], links: [] }, setData: 0, flights: [], destroyed: false, controls: { enabled: true }, pointer: true };
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
            case "controls":
              return () => fake.controls;
            case "enablePointerInteraction":
              return (on?: boolean) => {
                if (on === undefined) return fake.pointer;
                fake.pointer = on;
                return proxy;
              };
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

const MANY = [
  "https://example.com",
  "https://en.wikipedia.org/wiki/Minecraft",
  "https://www.rfc-editor.org/rfc/rfc9110",
  "https://en.wikipedia.org/wiki/Mojang_Studios",
  "https://en.wikipedia.org/wiki/Microsoft",
];
/** one chat that found five embeddable pages */
function manyPages(): Omit<AgentState, "streaming"> {
  return {
    chats: [{ id: "m", title: "Chat M", createdAt: 1, updatedAt: 1 }],
    messages: {
      m: [{
        id: "m1", role: "assistant", content: "", createdAt: 1,
        tools: [{ id: "m-s", name: "Tavily", query: "many", status: "done", sources: MANY.map((url) => ({ title: `Title ${url}`, url })) }] as never,
      }],
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
const pagesOf = (fake: Fake) => fake.data.nodes.filter((n) => n.kind === "page");
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

    act(() => fake.camera.position.set(page.x!, page.y!, page.z! + 50));
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(1));
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://example.com/");
    expect(frame.getAttribute("sandbox")).toBe(IFRAME_SANDBOX);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(host.dataset.pages).toBe("https://example.com/");
    expect(host.dataset.pinned).toBeUndefined();
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
    expect(host.dataset.pages).toBeUndefined();
  });

  it("pins a clicked page open: it flies there and the page stays as the camera leaves", async () => {
    seed();
    const { fake, host } = await mount();
    const page = node(fake, "page:example.com");
    act(() => fake.click!(page));
    expect(fake.flights.at(-1)?.ms).toBe(800);
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(1));
    expect(host.dataset.pinned).toBe("https://example.com/");
    act(() => fake.camera.position.set(page.x!, page.y!, page.z! + PAGE_FAR + 4000));
    await frames();
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
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

    // the close button of the only page flies back out, and the card goes
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
    expect(host.dataset.pages).toBe("https://example.com/");

    act(() => host.querySelector<HTMLButtonElement>("[data-panel-close]")!.click());
    await frames();
    expect(host.querySelector("[data-graph-panel]")).toBeNull();
    const camera = fake.camera.position;
    for (const n of fake.data.nodes.filter((n) => n.kind === "page"))
      expect(camera.distanceTo({ x: n.x!, y: n.y!, z: n.z! } as never)).toBeGreaterThan(PAGE_FAR);
  });

  it(`keeps several clicked pages open together, at most ${MAX_PAGES}: the oldest pin goes first`, async () => {
    seed(manyPages());
    const { fake, host } = await mount();
    const pages = pagesOf(fake);
    const urls = pages.map((p) => p.url!);
    const panels = () => [...host.querySelectorAll<HTMLElement>("[data-graph-panel]")].map((p) => p.dataset.graphPanel);

    for (const p of pages.slice(0, 3)) act(() => fake.click!(p));
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(3));
    expect(panels().sort()).toEqual(urls.slice(0, 3).sort());

    act(() => fake.click!(pages[3]));
    act(() => fake.click!(pages[4]));
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(MAX_PAGES));
    await frames();
    expect(panels()).toHaveLength(MAX_PAGES);
    expect(panels()).not.toContain(urls[0]);
    expect(host.dataset.pinned).toBe(urls.slice(1).join(" "));
  });

  it("× closes only its own page, and leaves the camera where it is", async () => {
    seed(manyPages());
    const { fake, host } = await mount();
    const [a, b] = pagesOf(fake);
    act(() => fake.click!(a));
    act(() => fake.click!(b));
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(2));
    const flights = fake.flights.length;
    const panel = host.querySelector<HTMLElement>(`[data-graph-panel="${a.url}"]`)!;
    act(() => panel.querySelector<HTMLButtonElement>("[data-panel-close]")!.click());
    await frames();
    expect([...host.querySelectorAll<HTMLElement>("[data-graph-panel]")].map((p) => p.dataset.graphPanel)).toEqual([b.url]);
    expect(fake.flights).toHaveLength(flights);
  });

  it("hands all input to the page under the pointer, and gives it back on the way out", async () => {
    seed(manyPages());
    const { fake, host } = await mount();
    const [a, b] = pagesOf(fake);
    act(() => fake.click!(a));
    act(() => fake.click!(b));
    await waitFor(() => expect(host.querySelectorAll("iframe")).toHaveLength(2));
    const one = host.querySelector<HTMLElement>(`[data-graph-panel="${a.url}"]`)!;
    const two = host.querySelector<HTMLElement>(`[data-graph-panel="${b.url}"]`)!;

    act(() => { one.dispatchEvent(new PointerEvent("pointerenter")); });
    expect(fake.controls.enabled).toBe(false);
    expect(fake.pointer).toBe(false);
    expect(one.dataset.live).toBe("");
    expect(two.dataset.live).toBeUndefined();

    act(() => { one.dispatchEvent(new PointerEvent("pointerleave")); });
    expect(fake.controls.enabled).toBe(true);
    expect(fake.pointer).toBe(true);
    expect(one.dataset.live).toBeUndefined();

    // a missed pointerleave: the next move over the graph itself ends it
    act(() => { two.dispatchEvent(new PointerEvent("pointerenter")); });
    expect(fake.controls.enabled).toBe(false);
    act(() => { host.querySelector("canvas")!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })); });
    expect(fake.controls.enabled).toBe(true);

    // closing the hovered page gives the graph its controls back too
    act(() => { two.dispatchEvent(new PointerEvent("pointerenter")); });
    act(() => two.querySelector<HTMLButtonElement>("[data-panel-close]")!.click());
    expect(fake.controls.enabled).toBe(true);
  });

  it("hides a pinned page once it is behind the camera, and shows it again in front", async () => {
    seed();
    const { fake, host } = await mount();
    const page = node(fake, "page:example.com");
    act(() => fake.click!(page));
    await waitFor(() => expect(host.querySelector("iframe")).not.toBeNull());
    const panel = host.querySelector<HTMLElement>("[data-graph-panel]")!;
    // past the page, still looking down -z: the page is behind the viewer
    act(() => {
      fake.camera.position.set(page.x!, page.y!, page.z! - 100);
      fake.camera.lookAt(page.x!, page.y!, page.z! - 1000);
    });
    await waitFor(() => expect(panel.style.display).toBe("none"));
    expect(host.querySelector("iframe")).not.toBeNull(); // still open, just not drawn
    act(() => {
      fake.camera.position.set(page.x!, page.y!, page.z! + 300);
      fake.camera.lookAt(page.x!, page.y!, page.z!);
    });
    await waitFor(() => expect(panel.style.display).toBe(""));
  });

  it("re-aims the controls along the view when they take over again, so the view doesn't snap", async () => {
    const THREE = await import("three");
    seed();
    const { fake, host } = await mount();
    act(() => fake.click!(node(fake, "page:example.com")));
    await waitFor(() => expect(host.querySelector("[data-graph-panel]")).not.toBeNull());
    const panel = host.querySelector<HTMLElement>("[data-graph-panel]")!;
    act(() => { panel.dispatchEvent(new PointerEvent("pointerenter")); });
    fake.controls.target = new THREE.Vector3(5000, 0, 0); // stale while disabled
    act(() => { panel.dispatchEvent(new PointerEvent("pointerleave")); });
    const ahead = fake.camera.getWorldDirection(new THREE.Vector3());
    const toTarget = fake.controls.target.clone().sub(fake.camera.position).normalize();
    expect(toTarget.dot(ahead)).toBeCloseTo(1);
  });

  it("doesn't hand input to a page mid-drag on the graph", async () => {
    seed();
    const { fake, host } = await mount();
    act(() => fake.click!(node(fake, "page:example.com")));
    await waitFor(() => expect(host.querySelector("[data-graph-panel]")).not.toBeNull());
    const panel = host.querySelector<HTMLElement>("[data-graph-panel]")!;
    act(() => { host.querySelector("canvas")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    act(() => { panel.dispatchEvent(new PointerEvent("pointerenter")); });
    expect(fake.controls.enabled).toBe(true);
    act(() => { window.dispatchEvent(new PointerEvent("pointerup")); });
    await act(() => new Promise((r) => setTimeout(r, 5)));
    act(() => { panel.dispatchEvent(new PointerEvent("pointerenter")); });
    expect(fake.controls.enabled).toBe(false);
  });

  it("draws conflicts solid, opaque red with nothing drifting, wider than an agreement", () => {
    expect(LINK_STYLE.conflicts).toMatchObject({ color: "#DC2626", particles: 0, opaque: true });
    expect(LINK_STYLE.conflicts.width).toBeGreaterThan(LINK_STYLE.agrees.width);
    expect(LINK_STYLE.agrees.opaque).toBeUndefined();
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
