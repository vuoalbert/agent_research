"use client";

import { useEffect, useRef } from "react";

import type { ForceGraph3DInstance } from "3d-force-graph";

/**
 * ForceGraph3D — vasturiano's `3d-force-graph`, used directly (no React
 * wrapper) and loaded only in the browser, inside the effect: it needs
 * `window` and WebGL. It fills its parent and follows the parent's size with a
 * ResizeObserver. Unmounting calls the library's `_destructor()`, which stops
 * the animation loop and disposes the renderer; the cleanup then drops the
 * WebGL context and the canvas as well.
 *
 * Light theme for the white canvas: ink/grey nodes, the tabs' outline grey for
 * links, the node's name as its hover label. Default orbit/drag/zoom controls.
 */

type Node = { id: number; name: string; group: number };
type Link = { source: number; target: number };

/** the app's ink tones, darkest first; a node's colour is its depth in the tree */
const NODE_COLORS = ["#1F2124", "#4A4D52", "#7A7D83", "#A3A6AB"];
/** the side tabs' outline grey */
const LINK_COLOR = "#D6D7D9";
export const PLACEHOLDER_NODE_COUNT = 48;

/** mulberry32: a tiny seeded PRNG, so the placeholder graph is the same every time */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random tree, as in the library's README example — deterministic. */
export function placeholderGraph(count = PLACEHOLDER_NODE_COUNT, seed = 7) {
  const random = seeded(seed);
  const depth: number[] = [0];
  const links: Link[] = [];
  for (let id = 1; id < count; id++) {
    const parent = Math.round(random() * (id - 1));
    depth[id] = depth[parent] + 1;
    links.push({ source: id, target: parent });
  }
  const nodes: Node[] = depth.map((d, id) => ({ id, name: `Node ${id}`, group: d }));
  return { nodes, links };
}

export function ForceGraph3D({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let graph: ForceGraph3DInstance | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    void import("3d-force-graph").then(({ default: ForceGraph }) => {
      if (cancelled) return;
      graph = new ForceGraph(container)
        .width(container.clientWidth)
        .height(container.clientHeight)
        .backgroundColor("#ffffff")
        .showNavInfo(false)
        .nodeLabel("name")
        .nodeColor((node) => NODE_COLORS[Math.min((node as Node).group, NODE_COLORS.length - 1)])
        .nodeOpacity(0.95)
        .linkColor(() => LINK_COLOR)
        .linkOpacity(1)
        .graphData(placeholderGraph());
      /* what the library holds, for checks from outside */
      container.dataset.nodes = String(graph.graphData().nodes.length);

      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect;
          graph?.width(Math.floor(width)).height(Math.floor(height));
        });
        observer.observe(container);
      }
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (graph) {
        /* the destructor disposes the renderer but leaves its context and
           canvas: release the one and remove the other too */
        const renderer = graph.renderer();
        graph._destructor();
        renderer.forceContextLoss();
        container.replaceChildren();
      }
      graph = null;
    };
  }, []);

  return <div ref={containerRef} data-force-graph="" className={className} />;
}
