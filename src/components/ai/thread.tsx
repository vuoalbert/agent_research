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
 * conversation set at different sizes read as a quotation and a reply to it.
 *
 * **Scrolling is shadcn's Message Scroller.** Each user message is a scroll
 * anchor: sending one settles it near the top of the viewport with blank room
 * under it, and the reply streams into that room. `autoScroll` follows the
 * reply while the reader stays at the live edge (the bottom); scrolling away
 * releases it, so nobody is pulled down while reading. A reopened chat lands
 * on its last user message (`last-anchor`), not the absolute bottom.
 */

import { AnimatePresence, motion } from "motion/react";

import { DURATION, bodyVariants, popVariants, timing, useReduced } from "@/lib/motion-tokens";

import { NO_SCROLLBAR, THREAD_COLUMN } from "@/components/ai/tokens";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { Message } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

const MotionContent = motion.create(MessageScrollerContent);
const MotionItem = motion.create(MessageScrollerItem);

export function AiThread({
  messages,
  streaming = false,
}: {
  messages: readonly Message[];
  /** a reply is in flight: the empty assistant turn shimmers until it fills */
  streaming?: boolean;
}) {
  const reduce = useReduced();

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller>
        <MessageScrollerViewport data-ai="thread" className={NO_SCROLLBAR}>
          {/* the thread arrives as one body when a chat opens; the first turn
              sits 24px under the header strip */}
          <MotionContent
            aria-label="Conversation"
            aria-busy={streaming}
            data-ai="thread-list"
            className={cn(THREAD_COLUMN, "mx-auto gap-3 py-6")}
            variants={bodyVariants}
            initial={reduce ? false : "initial"}
            animate="animate"
            transition={timing(DURATION.move, reduce)}
          >
            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <MotionItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                  data-role={message.role}
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
                    <p className="rounded-xl bg-[var(--ai-chip)] px-4 py-2.5 text-[16px] leading-[25px] text-[var(--ai-ink)]">
                      {message.content}
                    </p>
                  ) : message.content === "" ? (
                    /* The turn exists before its first token does, so the reader
                       has something to watch: three bars on the text's own rhythm. */
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
                </MotionItem>
              ))}
            </AnimatePresence>
          </MotionContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
