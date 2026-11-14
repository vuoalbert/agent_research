"use client";

/**
 * THE AI PANE — the content card, on the `/ai` route.
 *
 * It stands where `<WorkItemsList/>` stands on every other route and keeps that
 * card's measured box exactly: `rounded-r-[8px]` (the left corners are square,
 * where it meets the sidebar), a 1px `--plane-border` on all
 * four edges, white ground, inner edges **x 311..1431 / y 41..891**. Inside it,
 * `<AiHeader/>` takes the same 44px strip the list header takes, so the region
 * this file lays out is **1120 x 806** — measured in the browser, not assumed,
 * and every number on this screen is scaled to it (see `tokens.ts`).
 *
 * ── Three slots in a column ──────────────────────────────────────────────────
 * Everything below the strip is: what is above the composer, the composer, and
 * what is below it. The two screens differ only in what fills the first and the
 * third.
 *
 *   home    35% spacer      | box, 760, mark behind it | Chats/Routines + tasks
 *   chat    thread, scrolls | bar, 840, 16px radius    | the disclosure line
 *
 * - **The 35% above the box.** It is a `min-h` on the region above rather than a
 *   `top` on the composer, because the same region holds the thread: with
 *   nothing said it is exactly 35% and the box is where the source screen puts
 *   it; with something said it is the thread and grows from the same line. A
 *   `top: 35%` would have needed a second layout for the second state.
 * - **`LayoutGroup` is what makes the composer's move one animation** rather
 *   than a jump. The slots around it mount and unmount, and every
 *   layout-animated element in a group re-measures together when any of them
 *   changes; without it the composer would measure itself against a page that
 *   had already finished rearranging.
 * - **`mode="popLayout"` on both presences** is load-bearing: an exiting child
 *   leaves the flow immediately, so the cards fading out do not hold 418px of
 *   column open under a bar that has already docked — which would be the
 *   composer animating to a position that is about to move again.
 *
 * ── What "a chat is open" means ──────────────────────────────────────────────
 * One boolean, read off the thread and not off a mode: a conversation either has
 * something in it or it does not. `newChat()` opens an empty one, which is
 * deliberately still the home screen — pressing New should give you the box back,
 * not an empty transcript.
 */

import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";
import { useEffect, useState } from "react";

import { AiComposer } from "@/components/ai/composer";
import { AiDockedFootnote } from "@/components/ai/docked-bar";
import { AiHeader } from "@/components/ai/ai-header";
import { AiHomeCards } from "@/components/ai/home-cards";
import { AiThread } from "@/components/ai/thread";
import { DOCK_SWAP, NO_SCROLLBAR, PANE_TONES } from "@/components/ai/tokens";
import { useAgentStore } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

export function AiPane() {
  const reduce = useReducedMotion();
  /* One transition for the whole swap — the composer's move, its corner, its
     counter-scaled contents, the thread's arrival and the cards' exit. Several
     curves near each other is several things happening at once; one curve is a
     screen changing. Reduced motion collapses it to a straight swap, which is
     also what the screenshot harness sees. */
  const swap = reduce ? { duration: 0 } : DOCK_SWAP;

  const {
    chats,
    messages,
    activeChatId,
    streaming,
    newChat,
    openChat,
    sendMessage,
    seedIfEmpty,
    stopStreaming,
  } = useAgentStore();
  const [value, setValue] = useState("");

  /* The workspace loads when the pane that shows it mounts. In an effect and not
     at module load, because the store reads `localStorage` and a module that
     touched it on import would render one thing on the server and another on the
     client. Idempotent — a second mount finds chats and does nothing. */
  useEffect(() => {
    seedIfEmpty();
  }, [seedIfEmpty]);

  const visibleChats = chats.filter((chat) => !chat.archived);
  const activeChat = visibleChats.find((chat) => chat.id === activeChatId);
  const thread = activeChat ? (messages[activeChat.id] ?? []) : [];
  const docked = thread.length > 0;
  /** a reply is arriving into the chat on screen */
  const isStreaming = activeChatId !== null && streaming.includes(activeChatId);

  /* A send creates the chat if there is not one yet, which is what makes the
     home box and the docked bar the same control: you do not open a conversation
     and then say something, you say something and that is the conversation.

     Clearing the field is this component's job and not the composer's, and that
     is beui's contract rather than an oversight: `PromptInput` empties its *own*
     state on submit and leaves a controlled `value` alone, because an owner that
     is handed the value is the only thing that can know whether sending should
     clear it. Here it should. */
  const send = (text: string) => {
    setValue("");
    sendMessage(activeChatId ?? newChat(), text);
  };

  return (
    <main
      data-region="ai-pane"
      style={PANE_TONES}
      className="flex h-full flex-col overflow-hidden rounded-r-[8px] border border-plane-border bg-plane-pane"
    >
      {/* The strip is empty on the home screen and carries the conversation's
          title once there is one. Same 44px box either way, so nothing below it
          moves when a chat opens. */}
      <AiHeader title={docked ? activeChat?.title : undefined} />

      <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden bg-plane-pane">
        <LayoutGroup>
          <AnimatePresence mode="popLayout" initial={false}>
            {docked ? (
              <motion.div
                key="thread"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={swap}
                className="min-h-0 w-full flex-1"
              >
                <AiThread messages={thread} streaming={isStreaming} />
              </motion.div>
            ) : (
              /* The 35% the composer's top edge stands on, with nothing in it.
                 A `min-h` and not a `h`, so the field growing to three lines
                 pushes the cards down instead of covering them. */
              <motion.div
                key="home-space"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={swap}
                className="min-h-[35%] w-full shrink-0"
              />
            )}
          </AnimatePresence>

          <AiComposer
            value={value}
            onValueChange={setValue}
            onSubmit={send}
            docked={docked}
            streaming={isStreaming}
            onStop={activeChatId ? () => stopStreaming(activeChatId) : undefined}
            transition={swap}
          />

          <AnimatePresence mode="popLayout" initial={false}>
            {docked ? (
              <AiDockedFootnote key="footnote" transition={swap} />
            ) : (
              /* Everything under the box, in its own scroller rather than the
                 pane's. The composer's top edge is pinned to 35% of the pane and
                 the mark is measured against it; one scroller over the whole
                 column would make that line depend on how much content happened
                 to sit below it, and a percentage inside a scroll container has
                 no definite height to resolve against. */
              <motion.div
                key="home-cards"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={swap}
                className={cn(
                  "min-h-0 w-full flex-1 overflow-y-auto",
                  NO_SCROLLBAR,
                )}
              >
                <AiHomeCards
                  chats={visibleChats}
                  onUsePrompt={setValue}
                  onOpenChat={openChat}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </main>
  );
}
