"use client";

import { Globe } from "lucide-react";
import { useEffect } from "react";

import { useTabView } from "@/components/tab-view-context";
import { useNow } from "@/components/visualize/use-jobs";
import { useAgentStore } from "@/lib/agent-store";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/visualize";

import { useWorld } from "./use-world";

/**
 * The World Labs page (a full-width tab view): the ACTIVE chat's one world.
 *
 *   - no world yet: "Research something to build a world";
 *   - generating: its title, the time since it started, and World Labs' own
 *     progress line ("usually a few minutes");
 *   - failed: why;
 *   - ready: the walkable world itself — the viewer page (public/world/viewer.html,
 *     three.js + Spark streaming the splat from the World Labs CDN) in a
 *     same-origin iframe, so it can call /api/world/*. Unmounting the iframe on
 *     close destroys its document, and with it the WebGL context.
 *
 * Escape inside the world first releases the mouse; once it is free, the
 * viewer posts `world:escape` and this closes the view, as Escape does in the
 * other full views. The header leaves room for FullTabView's Back button.
 */

export const VIEWER_PATH = "/world/viewer.html";

export function WorldView({ className }: { className?: string }) {
  const { activeChatId } = useAgentStore();
  const world = useWorld(activeChatId, { watchEmpty: true });
  const close = useTabView()?.closeView;
  const now = useNow(world?.status === "generating");

  useEffect(() => {
    if (!close) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && (event.data as { type?: string })?.type === "world:escape") close();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [close]);

  if (activeChatId && world === undefined) return <div data-world="loading" className={className} />;

  if (!activeChatId || !world) {
    return (
      <div data-world="empty" className={cn("flex flex-col items-center justify-center gap-2 px-6 text-center", className)}>
        <Globe aria-hidden size={22} className="text-plane-faint" />
        <p className="text-[15px] font-medium text-plane-ink">Research something to build a world</p>
        <p className="max-w-[380px] text-[13px] leading-5 text-plane-muted">
          A chat&apos;s first research answer gets a walkable World Labs world, with its key facts floating in it. It builds in
          the background and shows up here.
        </p>
      </div>
    );
  }

  if (world.status === "ready") {
    return (
      <iframe
        key={world.chatId}
        data-world="ready"
        title={world.title}
        src={`${VIEWER_PATH}?chat=${encodeURIComponent(world.chatId)}`}
        allow="fullscreen"
        className={cn("block border-0 bg-black", className)}
      />
    );
  }

  return (
    <section data-world={world.status} aria-label={world.title} className={cn("flex flex-col bg-plane-pane", className)}>
      {/* pl leaves the Back button (16px in, ~72px wide) its corner */}
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-plane-border pr-5 pl-[104px]">
        <h2 className="min-w-0 truncate text-[15px] leading-6 font-medium text-plane-ink">{world.title}</h2>
        {world.status === "generating" && (
          <span data-elapsed="" className="shrink-0 text-[13px] text-plane-muted tabular-nums">
            {formatElapsed(now - world.createdAt)}
          </span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4 pb-5">
        {world.status === "generating" ? (
          <>
            <p className="text-[13px] leading-5 text-plane-muted">
              World Labs is building this world from the chat&apos;s research. It usually takes a few minutes.
            </p>
            <p data-world-progress="" className="flex items-center gap-2 text-[13px] leading-5 text-plane-ink-2">
              <span aria-hidden className="size-1.5 rounded-full bg-plane-state-progress motion-safe:animate-pulse" />
              {world.phase === "writing"
                ? "Writing the scene…"
                : world.phase === "submitting"
                  ? "Sending it to World Labs…"
                  : (world.progress ?? "Generating…")}
            </p>
          </>
        ) : (
          <p className="rounded-[8px] border border-plane-border bg-plane-band px-4 py-3 text-[13px] leading-5 text-plane-ink-2">
            {world.error ?? "This world could not be built."}
          </p>
        )}
      </div>
    </section>
  );
}
