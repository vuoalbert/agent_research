"use client";

import { useRef } from "react";

import { ForceGraph3D } from "@/components/force-graph-3d";
import { GraphChat } from "@/components/graph-chat";
import type { GraphControls } from "@/lib/graph-highlight";
import { cn } from "@/lib/utils";

/** ForceGraphView — the Force graph full view: the graph, and its chatbox over the bottom */
export function ForceGraphView({ className }: { className?: string }) {
  const controls = useRef<GraphControls | null>(null);
  return (
    <div className={cn("overflow-hidden", className)}>
      <ForceGraph3D className="absolute inset-0" controls={controls} />
      <GraphChat controls={controls} />
    </div>
  );
}
