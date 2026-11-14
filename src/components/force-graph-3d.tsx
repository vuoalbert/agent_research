"use client";

import { useEffect, useMemo, useRef } from "react";

import type { ForceGraph3DInstance } from "3d-force-graph";
import type { CSS3DSprite } from "three/examples/jsm/renderers/CSS3DRenderer.js";

import {
  PAGE_FAR,
  PANEL_SCALE,
  checkEmbeddable,
  createPanel,
  fitDistance,
  pickPage,
  type PageCandidate,
} from "@/components/graph-page-panel";
import { useAgentStore } from "@/lib/agent-store";
import { useReduced } from "@/lib/motion-tokens";
import {
  buildResearchGraph,
  countPages,
  graphSignature,
  type ResearchGraph,
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
 * Get the camera close to a page — scroll in, or click it to fly there — and
 * the page itself opens at the node, live, facing the camera: an <iframe> in a
 * CSS3DRenderer layer over the WebGL canvas. Only the nearest page in view
 * gets one, and it is unmounted again on the way out. Sites that forbid being
 * framed (asked of `/api/embed-check`) get a card that opens them in a new
 * tab instead. Nothing is captured or stored.
 *
 * It fills its parent and follows its size with a ResizeObserver. Unmounting
 * removes the panel, calls the library's `_destructor()` (animation loop,
 * renderer), drops the WebGL context and clears the container, which takes the
 * CSS3D layer with it.
 */

type GraphNode = ResearchNode & { x?: number; y?: number; z?: number };

const NODE_VAL: Record<ResearchNodeKind, number> = { chat: 10, search: 3.5, page: 1.8 };
/** the app's ink tones: conversations darkest, pages lightest */
const NODE_COLOR: Record<ResearchNodeKind, string> = { chat: "#1F2124", search: "#6B6F75", page: "#A3A6AB" };
export type LinkStyle = {
  /** any CSS colour; an alpha channel fades the link */
  color: string;
  /** 0 draws a hairline; more draws a tube that wide */
  width: number;
  /** particles drifting along the link, source → target */
  particles: number;
};
/**
 * One entry per link kind — a new kind (say, pages that agree or conflict)
 * adds its row here. Greys for the research trail; the one accent, a muted
 * blue, for pages read side by side. Red is kept for future "conflicts" links.
 */
export const LINK_STYLE: Record<ResearchLinkKind, LinkStyle> = {
  asked: { color: "#A3A6AB", width: 0.6, particles: 0 },
  "built-on": { color: "#6B6F75", width: 1.1, particles: 0 },
  found: { color: "#D6D7D9", width: 0, particles: 0 },
  read: { color: "#A3A6AB", width: 0.35, particles: 0 },
  "cross-ref": { color: "rgba(107, 138, 253, 0.7)", width: 0.7, particles: 0 },
};
const linkStyle = (link: object) => LINK_STYLE[(link as { kind: ResearchLinkKind }).kind];
/** the least distance a click parks the camera from a chat or a search; it
 *  backs further out if a page would still be within PAGE_FAR */
const FLY_DISTANCE: Record<Exclude<ResearchNodeKind, "page">, number> = { chat: 320, search: 260 };
const FLY_MS = 800;
const KIND_LABEL: Record<ResearchNodeKind, string> = { chat: "Chat", search: "Search", page: "Page" };
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

export function ForceGraph3D({ className }: { className?: string }) {
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

  useEffect(() => {
    reduceRef.current = reduce;
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
        .nodeColor((node) => NODE_COLOR[(node as GraphNode).kind])
        .nodeOpacity(0.95)
        .nodeResolution(12)
        .linkColor((link) => linkStyle(link).color)
        .linkWidth((link) => linkStyle(link).width)
        .linkOpacity(0.9)
        .linkDirectionalParticles((link) => linkStyle(link).particles)
        .linkDirectionalParticleColor((link) => linkStyle(link).color)
        .linkDirectionalParticleWidth((link) => Math.max(1.2, linkStyle(link).width * 2));
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
        return ms;
      };
      const pageFit = () => {
        const camera = graph.camera() as InstanceType<typeof THREE.PerspectiveCamera>;
        return fitDistance(camera.fov, camera.aspect);
      };
      /** a clicked page: it gets the panel over any nearer neighbour */
      let pinned: { id: string; until: number } | null = null;
      graph.onNodeClick((raw) => {
        const node = raw as GraphNode;
        const ms = node.kind === "page" ? flyTo(node, pageFit()) : flyTo(node, FLY_DISTANCE[node.kind], true);
        pinned = node.kind === "page" ? { id: node.id, until: performance.now() + ms + 250 } : null;
      });

      /* ------------------------------------------ the page at the camera */
      let open: { id: string; sprite: CSS3DSprite } | null = null;
      const unmount = () => {
        if (!open) return;
        /* removal fires the object's "removed" event, which takes its element
           — and the iframe with it — out of the DOM */
        graph.scene().remove(open.sprite);
        open = null;
        delete container.dataset.page;
      };
      const mount = (node: GraphNode) => {
        unmount();
        const page = { id: node.id, url: node.url!, title: node.label, host: node.host ?? "" };
        const panel = createPanel(page, {
          /* back out until no page is in reach, so this one closes and no
             other opens in its place */
          onClose: () => {
            pinned = null;
            flyTo(node, FLY_DISTANCE.search, true);
          },
          forwardWheel: (event) =>
            graph.renderer().domElement.dispatchEvent(new WheelEvent("wheel", event)),
        });
        const sprite = new CSS3DSprite(panel.element);
        sprite.scale.setScalar(PANEL_SCALE);
        sprite.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
        graph.scene().add(sprite);
        open = { id: node.id, sprite };
        container.dataset.page = page.url;
        void checkEmbeddable(page.url).then((answer) => {
          if (open?.sprite !== sprite) return;
          panel.setState(answer.embeddable ? "page" : "card", answer.reason);
        });
      };
      closePanel = unmount;

      const frustum = new THREE.Frustum();
      const matrix = new THREE.Matrix4();
      const point = new THREE.Vector3();
      const candidates: PageCandidate[] = [];
      const byId = new Map<string, GraphNode>();
      const tick = () => {
        frame = requestAnimationFrame(tick);
        byId.clear();
        for (const node of live?.signature ? (graph.graphData().nodes as GraphNode[]) : []) {
          if (node.kind === "page" && node.url && node.x !== undefined) byId.set(node.id, node);
        }
        if (byId.size === 0 && !open) return;
        const camera = graph.camera();
        camera.updateMatrixWorld();
        matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(matrix);
        candidates.length = 0;
        for (const node of byId.values()) {
          point.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
          candidates.push({ id: node.id, distance: point.distanceTo(camera.position), inView: frustum.containsPoint(point) });
        }
        const current = open?.id ?? null;
        const next = pickPage(candidates, current, pinned?.id ?? null);
        /* unpin once the pinned page has been left behind, or the flight to
           it ended (or was interrupted) without reaching it */
        if (pinned && next !== pinned.id && (current === pinned.id || performance.now() > pinned.until)) pinned = null;
        if (next !== current) {
          if (next) mount(byId.get(next)!);
          else unmount();
        }
        /* follow the node while the layout still moves it */
        const node = open && byId.get(open.id);
        if (open && node) open.sprite.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
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
  }, []);

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
