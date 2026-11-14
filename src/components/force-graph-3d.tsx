"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";

import type { ForceGraph3DInstance } from "3d-force-graph";
import type { CSS3DSprite } from "three/examples/jsm/renderers/CSS3DRenderer.js";

import {
  PAGE_FAR,
  PANEL_SCALE,
  checkEmbeddable,
  closePage,
  createDeck,
  createPanel,
  fitDistance,
  openPages,
  pinPage,
  touchPage,
  updateNearby,
  type PageCandidate,
  type Panel,
} from "@/components/graph-page-panel";
import { useAgentStore } from "@/lib/agent-store";
import { isLinkDimmed, linkColorFor, nodeColorFor, type GraphControls, type Highlight } from "@/lib/graph-highlight";
import { CROSSREF_LINK_STYLE } from "@/lib/crossref-links";
import { useReduced } from "@/lib/motion-tokens";
import {
  buildResearchGraph,
  countPages,
  graphSignature,
  type ResearchGraph,
  type ResearchLink,
  type ResearchLinkKind,
  type ResearchNode,
  type ResearchNodeKind,
} from "@/lib/research-graph";
import { cn } from "@/lib/utils";

/**
 * ForceGraph3D — the research graph: every non-archived chat, the searches it
 * ran and the pages they turned up, as a 3D force graph (vasturiano's
 * `3d-force-graph`, used directly, loaded only in the browser — it needs
 * `window` and WebGL). The data is `buildResearchGraph` over the chat store,
 * so new tool events grow the graph live; nodes already laid out keep their
 * place. Pages are one node per page across all chats, so chats that share a
 * source meet at it.
 *
 * Pages open at their nodes, live, facing the camera: an <iframe> in a
 * CSS3DRenderer layer over the WebGL canvas. Clicking a page pins it open
 * (and flies there); getting the camera close opens the nearest pages too, and
 * they unmount again on the way out. At most MAX_PAGES are open at once — see
 * the `Deck` in graph-page-panel. With the pointer over a page, the page takes
 * all input (scroll, click, type) and the graph's controls stand down. Sites
 * that forbid being framed (asked of `/api/embed-check`) get a card that opens
 * them in a new tab instead. Nothing is captured or stored.
 *
 * It fills its parent and follows its size with a ResizeObserver. Unmounting
 * removes the panel, calls the library's `_destructor()` (animation loop,
 * renderer), drops the WebGL context and clears the container, which takes the
 * CSS3D layer with it.
 */

type GraphNode = ResearchNode & { x?: number; y?: number; z?: number };

const NODE_VAL: Record<ResearchNodeKind, number> = { chat: 10, subagent: 5.5, search: 3.5, page: 1.8 };
/** the app's ink tones: conversations darkest, pages lightest */
const NODE_COLOR: Record<ResearchNodeKind, string> = { chat: "#1F2124", subagent: "#45484D", search: "#6B6F75", page: "#A3A6AB" };
export type LinkStyle = {
  /** any CSS colour; an alpha channel fades the link */
  color: string;
  /** 0 draws a hairline; more draws a tube that wide */
  width: number;
  /** particles drifting along the link, source → target (none under reduced motion) */
  particles: number;
  /** drawn fully opaque, not at the graph's shared link opacity */
  opaque?: boolean;
  particleWidth?: number;
  particleSpeed?: number;
};
/**
 * One entry per link kind — a new kind (say, pages that agree or conflict)
 * adds its row here. Greys for the research trail; the one accent, a muted
 * blue, for pages read side by side. Red is for `conflicts` only: pages that
 * contradict each other, a solid, fully opaque red link (`opaque`), nothing
 * drifting along it. `agrees` is solid grey, its width per link (more shared
 * claims, wider).
 */
export const LINK_STYLE: Record<ResearchLinkKind, LinkStyle> = {
  asked: { color: "#A3A6AB", width: 0.6, particles: 0 },
  "built-on": { color: "#6B6F75", width: 1.1, particles: 0 },
  found: { color: "#D6D7D9", width: 0, particles: 0 },
  read: { color: "#A3A6AB", width: 0.35, particles: 0 },
  "cross-ref": { color: "rgba(107, 138, 253, 0.7)", width: 0.7, particles: 0 },
  agrees: { color: CROSSREF_LINK_STYLE.agrees.color, width: CROSSREF_LINK_STYLE.agrees.width, particles: 0 },
  conflicts: { color: CROSSREF_LINK_STYLE.conflicts.color, width: CROSSREF_LINK_STYLE.conflicts.width, particles: 0, opaque: true },
};
const linkStyle = (link: object) => LINK_STYLE[(link as { kind: ResearchLinkKind }).kind];
/** a link's own width (agrees grows with its claims), else its kind's */
const linkWidthOf = (link: object) => (link as ResearchLink).width ?? linkStyle(link).width;
/** the least distance a click parks the camera from a chat or a search; it
 *  backs further out if a page would still be within PAGE_FAR */
const FLY_DISTANCE: Record<Exclude<ResearchNodeKind, "page">, number> = { chat: 320, subagent: 290, search: 260 };
const FLY_MS = 800;
/** a page nearer the camera's plane than this (world units) is not drawn */
const MIN_DEPTH = 12;
const KIND_LABEL: Record<ResearchNodeKind, string> = { chat: "Chat", subagent: "Subagent", search: "Search", page: "Page" };
export const EMPTY_TEXT = "Ask Claude to research something — sources show up here as a graph";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** the hover label; titles come from the web, so they are escaped */
function nodeLabel(node: GraphNode) {
  const kind = `<span style="opacity:.7">${KIND_LABEL[node.kind]}</span>`;
  const host = node.kind === "page" && node.host ? ` <span style="opacity:.7">· ${escapeHtml(node.host)}</span>` : "";
  return `${kind} ${escapeHtml(node.label)}${host}`;
}

type Live = {
  graph: ForceGraph3DInstance;
  /** what the graph holds now, so an identical rebuild is skipped */
  signature: string;
};

/** hand new data to the graph, reusing the objects of nodes it already placed */
function applyData(live: Live, data: ResearchGraph) {
  const signature = graphSignature(data);
  const held = live.signature ? (live.graph.graphData().nodes as GraphNode[]) : [];
  const placed = new Map(held.map((n) => [n.id, n]));
  const nodes = data.nodes.map((node) => {
    const existing = placed.get(node.id);
    return existing ? Object.assign(existing, node) : { ...node };
  });
  /* same ids, same links: titles updated in place, no re-layout */
  if (signature === live.signature) return;
  live.signature = signature;
  live.graph.graphData({ nodes, links: data.links.map((link) => ({ ...link })) });
}

/**
 * `controls` is the chatbox's hook into the graph (see graph-highlight.ts):
 * set once the graph has loaded, null again once it is gone.
 */
export function ForceGraph3D({
  className,
  controls: hook,
}: {
  className?: string;
  controls?: RefObject<GraphControls | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { chats, messages } = useAgentStore();
  const reduce = useReduced();

  const research = useMemo(() => buildResearchGraph(chats, messages), [chats, messages]);
  const empty = countPages(research) === 0;
  /* the graph shows nothing until there is a source to show */
  const data = useMemo<ResearchGraph>(() => (empty ? { nodes: [], links: [] } : research), [empty, research]);

  const dataRef = useRef(data);
  const reduceRef = useRef(reduce);
  const liveRef = useRef<Live | null>(null);
  /** the chatbox's highlight: null dims nothing */
  const highlightRef = useRef<Highlight>(null);

  useEffect(() => {
    reduceRef.current = reduce;
    // re-read the particle counts: conflicts drift only with motion allowed
    const graph = liveRef.current?.graph;
    if (graph) graph.linkDirectionalParticles(graph.linkDirectionalParticles());
  }, [reduce]);

  useEffect(() => {
    dataRef.current = data;
    const live = liveRef.current;
    if (live) {
      applyData(live, data);
      const host = containerRef.current;
      if (host) {
        host.dataset.nodes = String(data.nodes.length);
        host.dataset.links = String(data.links.length);
      }
    }
  }, [data]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let live: Live | null = null;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    let cancelled = false;
    let closePanel = () => {};

    void Promise.all([
      import("3d-force-graph"),
      import("three"),
      import("three/examples/jsm/renderers/CSS3DRenderer.js"),
    ]).then(([{ default: ForceGraph }, THREE, { CSS3DRenderer, CSS3DSprite }]) => {
      if (cancelled) return;
      const ahead = new THREE.Vector3();
      const opaqueMaterials = new Map<string, InstanceType<typeof THREE.MeshLambertMaterial>>();
      const css = new CSS3DRenderer();
      css.domElement.dataset.css3d = "";
      /* the layer lets everything through to the canvas's controls; only a
         page panel in it (pointer-events: auto) takes the pointer */
      css.domElement.style.pointerEvents = "none";
      const graph = new ForceGraph(container, { extraRenderers: [css] })
        .width(container.clientWidth)
        .height(container.clientHeight)
        .backgroundColor("#ffffff")
        .showNavInfo(false)
        .nodeId("id")
        .nodeLabel((node) => nodeLabel(node as GraphNode))
        .nodeVal((node) => NODE_VAL[(node as GraphNode).kind])
        .nodeColor((node) => nodeColorFor(highlightRef.current, (node as GraphNode).id, NODE_COLOR[(node as GraphNode).kind]))
        .nodeOpacity(0.95)
        .nodeResolution(12)
        .linkColor((link) => linkColorFor(highlightRef.current, link as ResearchLink, linkStyle(link).color))
        .linkWidth(linkWidthOf)
        .linkOpacity(0.9)
        /* opaque kinds (conflicts) get their own solid material */
        .linkMaterial((link) => {
          const style = linkStyle(link);
          if (!style.opaque) return null;
          let material = opaqueMaterials.get(style.color);
          if (!material) opaqueMaterials.set(style.color, (material = new THREE.MeshLambertMaterial({ color: style.color })));
          return material;
        })
        /* agrees / conflicts: the claim(s) with ✓ / ✗ hosts, escaped upstream */
        .linkLabel((link) => (link as ResearchLink).label ?? "")
        .linkDirectionalParticles((link) =>
          reduceRef.current || isLinkDimmed(highlightRef.current, link as ResearchLink) ? 0 : linkStyle(link).particles,
        )
        .linkDirectionalParticleColor((link) => linkStyle(link).color)
        .linkDirectionalParticleSpeed((link) => linkStyle(link).particleSpeed ?? 0.01)
        .linkDirectionalParticleWidth(
          (link) => linkStyle(link).particleWidth ?? Math.max(1.2, linkWidthOf(link) * 2),
        );
      live = { graph, signature: "" };
      liveRef.current = live;

      /* ------------------------------------------------ flying to a node */
      /**
       * Fly to look at a node from `distance` along the current line of
       * sight. `clear` backs further out until no page is within PAGE_FAR, so
       * landing on a chat or a search — or closing a page — opens no page.
       */
      const flyTo = (node: GraphNode, distance: number, clear = false) => {
        const camera = graph.camera();
        const at = new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0);
        const away = camera.position.clone().sub(at);
        if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
        away.normalize();
        const to = at.clone().addScaledVector(away, distance);
        if (clear) {
          const pages = (graph.graphData().nodes as GraphNode[])
            .filter((n) => n.kind === "page" && n.x !== undefined)
            .map((n) => new THREE.Vector3(n.x, n.y ?? 0, n.z ?? 0));
          for (let d = distance; d < distance + 4000 && pages.some((p) => p.distanceTo(to) <= PAGE_FAR); d += 20) {
            to.copy(at).addScaledVector(away, d);
          }
        }
        const ms = reduceRef.current ? 0 : FLY_MS;
        graph.cameraPosition({ x: to.x, y: to.y, z: to.z }, { x: at.x, y: at.y, z: at.z }, ms);
        /* the flight only aims the controls while they are enabled; a page
           hovered mid-flight disables them, and re-enabling would then snap
           the view back to the old target — so aim them now */
        (graph.controls() as { target?: { set?: (x: number, y: number, z: number) => void } }).target?.set?.(at.x, at.y, at.z);
        return ms;
      };
      const pageFit = () => {
        const camera = graph.camera() as InstanceType<typeof THREE.PerspectiveCamera>;
        return fitDistance(camera.fov, camera.aspect);
      };

      /* ---------------------------------------------- the pages, live */
      const deck = createDeck();
      /** no page opens by proximity until a flight has landed */
      let flyingUntil = 0;
      const mounted = new Map<string, { sprite: CSS3DSprite; panel: Panel }>();
      const byId = new Map<string, GraphNode>();

      /* the panel under the pointer takes all input — wheel, clicks, drags,
         typing — so the camera controls and node picking stand down until
         the pointer leaves it */
      const controls = graph.controls() as { enabled?: boolean; target?: InstanceType<typeof THREE.Vector3> };
      let liveId: string | null = null;
      /** while disabled the controls stop following the camera (a flight
          aims only enabled controls): before they take over again, aim them
          along the current line of sight, at the same distance — or they
          would snap the view to wherever they last pointed */
      const aimControls = () => {
        if (!controls.target || controls.enabled) return;
        const camera = graph.camera();
        const reach = Math.max(1, camera.position.distanceTo(controls.target));
        camera.getWorldDirection(ahead);
        controls.target.copy(camera.position).addScaledVector(ahead, reach);
      };
      const setLive = (id: string | null) => {
        if (id === liveId) return;
        if (liveId) mounted.get(liveId)?.panel.setLive(false);
        liveId = id;
        if (id) mounted.get(id)?.panel.setLive(true);
        if (id === null) aimControls();
        controls.enabled = id === null;
        graph.enablePointerInteraction(id === null);
        if (id) container.dataset.livePage = id;
        else delete container.dataset.livePage;
      };
      /* a backstop for a missed pointerleave (say, leaving straight out of an
         iframe): any pointer move over the graph itself ends the hover */
      let pointer: { x: number; y: number } | null = null;
      /* a drag on the graph is under way: the controls must not be disabled
         mid-gesture — TrackballControls then skips its pointerup and keeps a
         stale pointer — so hover waits for the release */
      let pressed = false;
      const onGraphDown = (event: PointerEvent) => {
        if (!(event.target as Element | null)?.closest?.("[data-graph-panel]")) pressed = true;
      };
      /* after the controls' own pointerup has run */
      const onRelease = () => setTimeout(() => (pressed = false), 0);
      const onGraphPointer = (event: PointerEvent) => {
        pointer = { x: event.clientX, y: event.clientY };
        const over = (event.target as Element | null)?.closest?.("[data-graph-panel]");
        if (!over && liveId) setLive(null);
      };
      const onGraphLeave = () => {
        pointer = null;
      };
      container.addEventListener("pointermove", onGraphPointer, { capture: true });
      container.addEventListener("pointerover", onGraphPointer, { capture: true });
      container.addEventListener("pointerleave", onGraphLeave);
      container.addEventListener("pointerdown", onGraphDown, { capture: true });
      window.addEventListener("pointerup", onRelease);
      window.addEventListener("pointercancel", onRelease);
      /** a panel that opened (or flew in) under a resting pointer gets no
          pointerenter — the browser hands input to the iframe directly — so
          look under the pointer while nothing is live */
      const panelUnderPointer = () => {
        if (!pointer || liveId || pressed || mounted.size === 0 || typeof document.elementFromPoint !== "function") return;
        const over = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>("[data-graph-panel]");
        const hit = over && [...mounted].find(([, open]) => open.panel.element === over);
        if (hit) setLive(hit[0]);
      };

      const unmount = (id: string) => {
        const open = mounted.get(id);
        if (!open) return;
        if (liveId === id) setLive(null);
        /* removal fires the object's "removed" event, which takes its element
           — and the iframe with it — out of the DOM */
        graph.scene().remove(open.sprite);
        mounted.delete(id);
      };
      const mount = (node: GraphNode) => {
        const page = { id: node.id, url: node.url!, title: node.label, host: node.host ?? "" };
        const panel = createPanel(page, {
          onClose: () => {
            const only = mounted.size === 1;
            closePage(deck, node.id);
            sync();
            /* the last page: back out until no page is in reach, so no other
               opens in its place */
            if (only) flyingUntil = performance.now() + flyTo(node, FLY_DISTANCE.search, true) + 250;
          },
          /* over the chrome the graph still zooms: let the controls take this one wheel */
          forwardWheel: (event) => {
            const was = controls.enabled;
            controls.enabled = true;
            graph.renderer().domElement.dispatchEvent(new WheelEvent("wheel", event));
            controls.enabled = was;
          },
          onHover: (over) => {
            if (over && !pressed) setLive(node.id);
            else if (liveId === node.id) setLive(null);
          },
        });
        panel.element.addEventListener("pointerdown", () => touchPage(deck, node.id, performance.now()));
        const sprite = new CSS3DSprite(panel.element);
        sprite.scale.setScalar(PANEL_SCALE);
        sprite.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
        graph.scene().add(sprite);
        mounted.set(node.id, { sprite, panel });
        void checkEmbeddable(page.url).then((answer) => {
          if (mounted.get(node.id)?.sprite !== sprite) return;
          panel.setState(answer.embeddable ? "page" : "card", answer.reason);
        });
      };
      /** mount what the deck holds open, unmount the rest */
      const sync = () => {
        const want = openPages(deck);
        for (const id of [...mounted.keys()]) if (!want.includes(id)) unmount(id);
        for (const id of want) {
          const node = byId.get(id);
          if (node && !mounted.has(id)) mount(node);
        }
        /* what is open, for checks from outside: urls, space-separated */
        const urls = want.flatMap((id) => (mounted.has(id) ? [byId.get(id)!.url!] : [])).join(" ");
        if ((container.dataset.pages ?? "") !== urls) {
          if (urls) container.dataset.pages = urls;
          else delete container.dataset.pages;
        }
        const pinned = deck.pins.filter((id) => mounted.has(id)).map((id) => byId.get(id)!.url!).join(" ");
        if ((container.dataset.pinned ?? "") !== pinned) {
          if (pinned) container.dataset.pinned = pinned;
          else delete container.dataset.pinned;
        }
      };
      closePanel = () => {
        for (const id of [...mounted.keys()]) unmount(id);
        container.removeEventListener("pointermove", onGraphPointer, { capture: true });
        container.removeEventListener("pointerover", onGraphPointer, { capture: true });
        container.removeEventListener("pointerleave", onGraphLeave);
        container.removeEventListener("pointerdown", onGraphDown, { capture: true });
        window.removeEventListener("pointerup", onRelease);
        window.removeEventListener("pointercancel", onRelease);
      };

      const readPages = () => {
        byId.clear();
        for (const n of live?.signature ? (graph.graphData().nodes as GraphNode[]) : []) {
          if (n.kind === "page" && n.url && n.x !== undefined) byId.set(n.id, n);
        }
      };
      /** a clicked page is pinned open at once; the camera flies to frame it */
      /** the node last flown to, for the chatbox's "find more like this" */
      let focusedId: string | null = null;
      const flyToNode = (node: GraphNode) => {
        focusedId = node.id;
        const ms = node.kind === "page" ? flyTo(node, pageFit()) : flyTo(node, FLY_DISTANCE[node.kind], true);
        flyingUntil = performance.now() + ms + 250;
        if (node.kind === "page" && node.url) {
          readPages();
          pinPage(deck, node.id);
          sync();
        }
      };
      graph.onNodeClick((raw) => flyToNode(raw as GraphNode));
      if (hook) {
        hook.current = {
          focusNode: (id) => {
            const node = (graph.graphData().nodes as GraphNode[]).find((n) => n.id === id);
            if (node) flyToNode(node);
            return Boolean(node);
          },
          setHighlight: (ids) => {
            highlightRef.current = ids ? new Set(ids) : null;
            if (ids) container.dataset.highlight = String(highlightRef.current!.size);
            else delete container.dataset.highlight;
            // re-handing the accessors re-styles every node and link
            graph.nodeColor(graph.nodeColor()).linkColor(graph.linkColor());
            graph.linkDirectionalParticles(graph.linkDirectionalParticles());
          },
          getGraph: () => dataRef.current,
          getFocus: () => (focusedId && dataRef.current.nodes.some((n) => n.id === focusedId) ? focusedId : null),
        };
      }

      const frustum = new THREE.Frustum();
      const matrix = new THREE.Matrix4();
      const point = new THREE.Vector3();
      const candidates: PageCandidate[] = [];
      const tick = () => {
        frame = requestAnimationFrame(tick);
        readPages();
        if (byId.size === 0 && mounted.size === 0) return;
        const camera = graph.camera();
        camera.updateMatrixWorld();
        matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(matrix);
        candidates.length = 0;
        for (const n of byId.values()) {
          point.set(n.x ?? 0, n.y ?? 0, n.z ?? 0);
          candidates.push({ id: n.id, distance: point.distanceTo(camera.position), inView: frustum.containsPoint(point) });
        }
        const now = performance.now();
        updateNearby(deck, candidates, now, now > flyingUntil);
        sync();
        /* follow the nodes while the layout still moves them; a page at or
           behind the camera is hidden — projected through the viewer it
           would blow up across the view (and mis-route input to its iframe) */
        camera.getWorldDirection(ahead);
        for (const [id, open] of mounted) {
          const n = byId.get(id);
          if (n) open.sprite.position.set(n.x ?? 0, n.y ?? 0, n.z ?? 0);
          const inFront = point.copy(open.sprite.position).sub(camera.position).dot(ahead) > MIN_DEPTH;
          if (open.sprite.visible !== inFront) {
            open.sprite.visible = inFront;
            if (!inFront && liveId === id) setLive(null);
          }
        }
        panelUnderPointer();
      };
      if (typeof requestAnimationFrame !== "undefined") frame = requestAnimationFrame(tick);

      applyData(live, dataRef.current);
      /* what the library holds, for checks from outside */
      container.dataset.nodes = String(graph.graphData().nodes.length);
      container.dataset.links = String(graph.graphData().links.length);
      if (process.env.NODE_ENV === "development") {
        (window as unknown as { __researchGraph?: ForceGraph3DInstance }).__researchGraph = graph;
      }

      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect;
          graph.width(Math.floor(width)).height(Math.floor(height));
        });
        observer.observe(container);
      }
    });

    return () => {
      cancelled = true;
      if (hook) hook.current = null;
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      closePanel();
      if (live) {
        /* the destructor disposes the renderer but leaves its context and
           canvas: release the one, and clear the container of the canvas and
           the CSS3D layer */
        const renderer = live.graph.renderer();
        live.graph._destructor();
        renderer.forceContextLoss();
        container.replaceChildren();
        const w = window as unknown as { __researchGraph?: ForceGraph3DInstance };
        if (w.__researchGraph === live.graph) delete w.__researchGraph;
      }
      liveRef.current = null;
      live = null;
    };
    // `controls` is a ref object: stable, so the graph is built once
  }, [hook]);

  return (
    <div className={cn("overflow-hidden", className)}>
      <div ref={containerRef} data-force-graph="" className="absolute inset-0" />
      {empty && (
        <p
          data-graph-empty=""
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-plane-faint"
        >
          {EMPTY_TEXT}
        </p>
      )}
    </div>
  );
}
