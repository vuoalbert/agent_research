"use client";

import { ArrowUp, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addFoundSources, getAgentState, selectChatSources, sourceKey, type AgentState } from "@/lib/agent-store";
import { graphChatPayload, type GraphChatAnswer, type GraphChatGraph, type GraphControls } from "@/lib/graph-highlight";
import { pageNodeId } from "@/lib/research-graph";
import { cn } from "@/lib/utils";

/**
 * GraphChat — the small chatbox at the bottom of the Force graph. Ask where
 * something is ("take me to …") or what hangs together ("what is most
 * connected to …?"): the answer flies the camera to a node and dims every
 * node outside the related set. The latest reply sits above the box; Clear —
 * or Escape — restores the graph. Escape with no highlight is left alone, so
 * it still closes the view.
 *
 * The question goes to POST /api/graph-chat with the graph exactly as drawn
 * (`controls.getGraph()`), so the ids that come back are the graph's own.
 *
 * "Find more sources like this" / "search for X" runs a Telem search on the
 * server; what it finds is added to the chat the focused node belongs to (one
 * Telem call on its latest turn, marked as found from the graph), so the new
 * pages appear as nodes off that node — and in the Knowledge base.
 *
 * Only the box and the reply take the pointer; around them the graph keeps
 * its drag and wheel. Keys typed into the box stop at the box, so the
 * graph's camera controls never see them.
 */

export type AskGraph = (
  question: string,
  graph: GraphChatGraph,
  signal: AbortSignal,
  context?: { focus?: string | null; chatId?: string | null },
) => Promise<GraphChatAnswer>;

export const askGraph: AskGraph = async (question, graph, signal, context = {}) => {
  const response = await fetch("/api/graph-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question,
      graph,
      ...(context.focus ? { focus: context.focus } : {}),
      ...(context.chatId ? { chatId: context.chatId } : {}),
    }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as (GraphChatAnswer & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `graph chat failed (${response.status})`);
  return body;
};

export const PLACEHOLDER = "Ask the graph, or find more sources…";

/**
 * The chat a graph node belongs to: a chat, search or subagent node names it
 * in its id; a page belongs to the active chat if that chat has it, else to
 * the first live chat that does. Null when no live chat claims it.
 */
export function chatForNode(nodeId: string | null, state: Pick<AgentState, "chats" | "messages" | "activeChatId">): string | null {
  const live = state.chats.filter((chat) => !chat.archived);
  const isLive = (id: string | undefined) => (id && live.some((chat) => chat.id === id) ? id : null);
  if (nodeId) {
    const [kind, rest] = [nodeId.slice(0, nodeId.indexOf(":")), nodeId.slice(nodeId.indexOf(":") + 1)];
    if (kind === "chat") return isLive(rest);
    if (kind === "search" || kind === "subagent") return isLive(rest.split(":")[0]);
    if (kind === "page") {
      const order = [...live].sort((a, b) => Number(b.id === state.activeChatId) - Number(a.id === state.activeChatId));
      for (const chat of order) {
        if (selectChatSources(state.messages[chat.id]).some((source) => `page:${sourceKey(source.url)}` === nodeId)) return chat.id;
      }
    }
  }
  return isLive(state.activeChatId ?? undefined) ?? live.find((chat) => (state.messages[chat.id] ?? []).length > 0)?.id ?? null;
}

export function GraphChat({
  controls,
  ask = askGraph,
  className,
}: {
  controls: RefObject<GraphControls | null>;
  ask?: AskGraph;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<{ text: string; error?: boolean } | null>(null);
  const [highlighted, setHighlighted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const clear = useCallback(() => {
    controls.current?.setHighlight(null);
    setHighlighted(false);
  }, [controls]);

  /* Escape clears the highlight — and only that: captured on window, ahead of
     the view's own Escape (which skips a defaultPrevented key) */
  useEffect(() => {
    if (!highlighted) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      clear();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [highlighted, clear]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const question = value.trim();
    const graph = controls.current?.getGraph();
    if (!question || pending || !graph) return;
    if (graph.nodes.length === 0) {
      setReply({ text: "The graph is empty — research something first." });
      return;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setPending(true);
    try {
      const focus = controls.current?.getFocus?.() ?? null;
      const answer = await ask(question, graphChatPayload(graph), abort.signal, {
        focus,
        chatId: chatForNode(focus, getAgentState()),
      });
      if (abort.signal.aborted) return;
      setValue("");
      setReply({ text: answer.reply });
      const view = controls.current;
      if (answer.found && answer.found.sources.length > 0) {
        const { query, from, sources } = answer.found;
        const chatId = chatForNode(from, getAgentState());
        if (!chatId) {
          setReply({ text: "Open a chat to keep what Telem found.", error: true });
          return;
        }
        const write = addFoundSources(chatId, { query, sources, origin: "graph", ...(from ? { from } : {}) });
        if (!view || !write) return;
        /* the new search and its pages, bright with the node they hang off */
        const bright = [
          ...(from ? [from] : []),
          `search:${chatId}:${write.messageId}:${write.callId}`,
          ...sources.map((source) => pageNodeId(source.url)),
        ];
        view.setHighlight(bright);
        setHighlighted(true);
        window.setTimeout(() => {
          if (from) controls.current?.focusNode(from);
        }, 120);
        return;
      }
      if (!view) return;
      if (answer.highlight.length > 0) {
        view.setHighlight(answer.highlight);
        setHighlighted(true);
      } else clear();
      const target = answer.focus ?? answer.highlight[0];
      if (target) view.focusNode(target);
    } catch (error) {
      if (abort.signal.aborted) return;
      setReply({ text: error instanceof Error ? error.message : "Something went wrong.", error: true });
    } finally {
      if (abortRef.current === abort) {
        abortRef.current = null;
        setPending(false);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // keys stay in the box (the graph's controls listen on window); Escape
    // goes on, to clear a highlight or close the view
    if (event.key !== "Escape") event.stopPropagation();
  };

  return (
    <div
      data-graph-chat=""
      className={cn("pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2 px-4", className)}
    >
      {(reply || highlighted) && (
        <div className="pointer-events-auto flex max-w-[420px] items-start gap-1">
          {reply && (
            <p
              data-graph-chat-reply=""
              role="status"
              className={cn(
                "rounded-xl border border-plane-border bg-plane-pane/90 px-3 py-1.5 text-[13px] leading-[18px] backdrop-blur-sm",
                reply.error ? "text-plane-prio-urgent" : "text-plane-muted",
              )}
            >
              {/* clamped inside the padding, so no third line peeks into it */}
              <span className="line-clamp-2">{reply.text}</span>
            </p>
          )}
          {reply && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss reply"
              onClick={() => setReply(null)}
              className="mt-1 shrink-0 rounded-full text-plane-faint"
            >
              <X aria-hidden />
            </Button>
          )}
          {highlighted && (
            <Button
              variant="ghost"
              size="xs"
              onClick={clear}
              data-graph-chat-clear=""
              className="mt-0.5 shrink-0 text-plane-ink-2"
            >
              Clear
            </Button>
          )}
        </div>
      )}
      <form
        onSubmit={submit}
        aria-busy={pending}
        className="pointer-events-auto flex h-10 w-full max-w-[420px] items-center gap-1 rounded-full border border-[#E1E2E3] bg-white pr-1 pl-4 shadow-[0_1px_2px_rgba(15,15,16,0.04)]"
      >
        <Input
          aria-label="Ask the graph"
          placeholder={PLACEHOLDER}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          className="h-full rounded-none border-0 bg-transparent px-0 text-[13px] text-plane-ink shadow-none placeholder:text-plane-faint focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
        />
        <Button
          type="submit"
          size="icon-sm"
          aria-label={pending ? "Asking…" : "Send"}
          disabled={pending || value.trim() === ""}
          className="shrink-0 rounded-full bg-plane-ink text-white hover:bg-plane-ink/85 disabled:opacity-30"
        >
          {pending ? <LoaderCircle aria-hidden className="motion-safe:animate-spin" /> : <ArrowUp aria-hidden />}
        </Button>
      </form>
    </div>
  );
}
