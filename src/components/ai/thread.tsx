"use client";

/**
 * The conversation, above the docked bar.
 *
 * Two shapes and only two: what you said is a grey bubble on the right, what
 * came back is plain text on the left. No avatar, no name, no timestamp per
 * turn — with one reader and one agent, a label on every line is a column of
 * the same word repeated.
 *
 * **16px on a 25px line, both halves.** Larger than the 14/20 the rest of the
 * app is set in, because this is the one place that reads like a conversation
 * rather than a list; and the *same* on both sides, because two halves of a
 * conversation set at different sizes read as a quotation and a reply to it. A
 * 1.55 line height rather than the app's 1.43 for the same reason — a message
 * set tighter than the paragraph it is reads as a caption.
 *
 * **Bottom-anchored.** The scroller is pinned to its own end on every new turn,
 * written to the node rather than held in state: this fires on every message and
 * a re-render per scroll offset is a lot of React for one number.
 */

import {AnimatePresence, motion} from "motion/react";
import { useEffect, useRef } from "react";

import { DURATION, bodyVariants, popVariants, timing,
  useReduced,
} from "@/lib/motion-tokens";

import { NO_SCROLLBAR, THREAD_COLUMN } from "@/components/ai/tokens";
import type { Message } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

export function AiThread({
  messages,
  streaming = false,
}: {
  messages: readonly Message[];
  /** a reply is in flight: the empty assistant turn shimmers until it fills */
  streaming?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const reduce = useReduced();

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length]);

  return (
    <div
      ref={scrollerRef}
      data-ai="thread"
      className={cn("h-full overflow-y-auto", NO_SCROLLBAR)}
    >
      {/* Top-anchored, in normal flow: the first turn sits 24px under the header
          strip and the thread grows downwards. It used to hang off the bottom
          on a `min-h-full` + `justify-end` wrapper, which put a short exchange
          at the foot of the pane under 600px of white. Reaching the newest
          message is the scroll effect's job, not the layout's. */}
      {/* the thread arrives as one body when a chat opens */}
      <motion.ol
        aria-label="Conversation"
        data-ai="thread-list"
        className={cn(THREAD_COLUMN, "mx-auto flex flex-col gap-3 py-6")}
        variants={bodyVariants}
        initial={reduce ? false : "initial"}
        animate="animate"
        transition={timing(DURATION.move, reduce)}
      >
        <AnimatePresence initial={false} mode="popLayout">
        {messages.map((message) => (
          <motion.li
            key={message.id}
            data-role={message.role}
            layout={reduce ? false : "position"}
            variants={popVariants}
            initial={reduce ? false : "initial"}
            animate="animate"
            exit="exit"
            transition={timing(DURATION.section, reduce)}
            className={cn(
              "max-w-[76%]",
              message.role === "user" ? "self-end" : "self-start",
            )}
          >
            {message.role === "user" ? (
              /* The padding moved with the type — 16px across, 10px down, the
               same ratio the 14/20 body would have had — so the bubble still
               hugs the words rather than gaining a margin it did not have. */
              <p className="rounded-xl bg-[var(--ai-chip)] px-4 py-2.5 text-[16px] leading-[25px] text-[var(--ai-ink)]">
                {message.content}
              </p>
            ) : message.content === "" ? (
              /* The turn exists before its first token does, so the reader has
                 something to watch. Three bars on the text's own rhythm rather
                 than a spinner, which would say "busy" where the answer is
                 about to be. */
              <span
                data-ai="pending"
                role="status"
                aria-label={streaming ? "Agent Research is replying" : undefined}
                className="flex flex-col gap-2 px-1 py-2"
              >
                {[220, 300, 160].map((width, i) => (
                  <span
                    key={width}
                    className="block h-[11px] rounded-full bg-[var(--ai-chip)] motion-safe:animate-pulse"
                    style={{ width, animationDelay: `${i * 140}ms` }}
                  />
                ))}
              </span>
            ) : (
              <p className="px-1 py-2 text-[16px] leading-[25px] text-[var(--ai-muted)]">
                {message.content}
              </p>
            )}
          </motion.li>
        ))}
        </AnimatePresence>
      </motion.ol>
    </div>
  );
}
