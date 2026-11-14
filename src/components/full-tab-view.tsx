"use client";

import { ArrowLeft } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";

import { ForceGraphView } from "@/components/force-graph-view";
import { useTabView } from "@/components/tab-view-context";
import { VisualizeView } from "@/components/visualize/visualize-view";
import { Button } from "@/components/ui/button";
import { exitDuration, timing, useReduced } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

/**
 * FullTabView — the full-width page a "full" side tab (World Labs, Force
 * graph, Visualize) opens instead of a side panel. The shell places this host over the
 * sidebar card and the chat card together (grid columns 2–3, row 2, pulled
 * 1px left onto the sidebar card's x=60 seam), above the side tabs and the
 * composer. The page keeps the cards' 8px gutters right and below, and their
 * 8px radius on all four corners.
 *
 * World Labs is a blank white canvas for now; Force graph fills its page with
 * a 3D force graph (src/components/force-graph-3d.tsx), and Visualize with the
 * figures Claude is building or has built (src/components/visualize/). The
 * Force graph has a chatbox to ask it questions (src/components/graph-chat.tsx).
 *
 * It slides in from past the host's right edge — the window's — and slides
 * back out the same way on close. The host clips (overflow: clip, never
 * hidden, so focus cannot scroll it mid-slide), so nothing overhangs the
 * page. While open, everything it covers is inert; closing hands focus back
 * to the tab that opened it. It never touches `--side-panel-inset`: the chat
 * under it stays exactly as it was.
 */

/** Seconds. A whole-screen surface: a step longer than the side panel's slide. */
const SLIDE = 0.32;
const SLIDE_BACK = exitDuration(SLIDE);

/** the shell columns a full view covers, marked in shell.tsx */
const COVERED = "[data-full-view-covers]";

export function FullTabView({ className }: { className?: string }) {
  const tabView = useTabView();
  const reduce = useReduced();
  const hostRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const view = tabView?.view ?? null;
  const close = tabView?.closeView;
  const openerRef = tabView?.openerRef;

  /* cover: what is under the page is out of reach while it is open */
  useEffect(() => {
    if (view === null) return;
    const grid = hostRef.current?.parentElement;
    const covered = grid ? [...grid.querySelectorAll<HTMLElement>(COVERED)] : [];
    for (const el of covered) el.inert = true;
    /* no scroll: the page is still off to the right, and focusing it would
       scroll the host to it and cut the slide short */
    backRef.current?.focus({ preventScroll: true });
    return () => {
      for (const el of covered) el.inert = false;
      openerRef?.current?.focus({ preventScroll: true });
    };
  }, [view, openerRef]);

  /* Escape closes, like Back */
  useEffect(() => {
    if (view === null || !close) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, close]);

  return (
    <div
      ref={hostRef}
      data-full-tab-host=""
      className={cn("pointer-events-none relative overflow-clip", className)}
    >
      <AnimatePresence initial={false}>
        {view && (
          /* The slider is the host's full box, gutters included, so x: 100%
             parks the page wholly past the window's right edge. */
          <motion.div
            key={view}
            className="absolute inset-0 pr-2 pb-2"
            initial={{ x: "100%" }}
            animate={{ x: 0, transition: timing(SLIDE, reduce) }}
            exit={{ x: "100%", transition: timing(SLIDE_BACK, reduce) }}
          >
            <section
              data-full-tab-view={view}
              aria-label={view}
              className="pointer-events-auto relative h-full overflow-hidden rounded-[8px] border border-plane-border bg-plane-pane"
            >
              {/* the canvas fills the page, under the Back button; mounted
                  only while this view is in the DOM, so it is destroyed once
                  the slide-out finishes */}
              {view === "Force graph" && <ForceGraphView className="absolute inset-0" />}
              {view === "Visualize" && <VisualizeView className="absolute inset-0" />}
              <Button
                ref={backRef}
                variant="ghost"
                size="sm"
                onClick={close}
                className="absolute top-4 left-4 z-10 bg-plane-pane/80 text-plane-ink-2"
              >
                <ArrowLeft aria-hidden />
                Back
              </Button>
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
