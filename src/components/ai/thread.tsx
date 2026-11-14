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
 * anchor: sending one settles it at the very top of the viewport — the list's
 * own 24px under the strip and nothing else, no slice of the turn before it —
 * with blank room under it, and the reply streams into that room. `autoScroll`
 * follows the reply while the reader stays at the live edge (the bottom);
 * scrolling away releases it, so nobody is pulled down while reading.
 *
 * - **Nothing above the anchor.** `scrollPreviousItemPeek={0}` stops the
 *   scroller keeping 64px of the previous turn in view. That alone parks the
 *   bubble 24px down with the previous turn's last 12px (the list's gap) still
 *   showing, so a turn that starts an exchange also stands 12px further off
 *   the reply before it: 24px between exchanges, the same 24 the list starts
 *   with, and the turn before ends exactly at the viewport's top edge.
 * - **A reopened chat lands where the send left it**: its last user message at
 *   the top. `last-anchor` does that only when the last exchange is taller than
 *   the viewport and falls back to the bottom otherwise, which leaves earlier
 *   turns showing above it — `LandOnLastAnchor` settles that case too, before
 *   the first paint and without motion.
 * - **Glide, but only for what is live.** Once the reader sends into this
 *   thread, the scroller's moves are eased (`useGlide`), so the new message
 *   glides up into place and following the reply eases rather than stepping a
 *   chunk at a time. A thread that mounted with a history lands instantly.
 *   Reduced motion never glides.
 */

import {
  AnimatePresence,
  animate,
  motion,
  type AnimationPlaybackControls,
} from "motion/react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import { DURATION, bodyVariants, popVariants, timing, useReduced } from "@/lib/motion-tokens";

import { NO_SCROLLBAR, THREAD_COLUMN, THREAD_GLIDE } from "@/components/ai/tokens";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import type { Message } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

const MotionContent = motion.create(MessageScrollerContent);
const MotionItem = motion.create(MessageScrollerItem);

/**
 * On mount, put the last scroll anchor at the top of the viewport if the
 * scroller's `last-anchor` default left it lower (it falls back to the end when
 * the last exchange fits). A layout effect after the content's, so it runs
 * once the scroller has placed the view and before anything is painted.
 * Skipped while a reply is arriving: then the scroller's own landing is the one
 * that follows it.
 */
function LandOnLastAnchor({
  viewportRef,
  skip,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  skip: boolean;
}) {
  const { scrollToMessage } = useMessageScroller();
  const [skipAtMount] = useState(skip);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (skipAtMount || !viewport) return;
    const anchors = viewport.querySelectorAll<HTMLElement>('[data-scroll-anchor="true"]');
    const anchor = anchors[anchors.length - 1];
    const id = anchor?.dataset.messageId;
    const list = anchor?.parentElement;
    if (!anchor || !id || !list) return;
    const inset = Number.parseFloat(getComputedStyle(list).paddingTop) || 0;
    const top = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    // already there: the scroller anchored it itself, or it is the first turn
    if (Math.abs(top - inset) <= 0.5) return;
    scrollToMessage(id, { align: "start", behavior: "instant" });
  }, [scrollToMessage, skipAtMount, viewportRef]);

  return null;
}

/** what the reader does to take the scroll back from a glide in flight */
const TAKE_OVER = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * While `on`, every move Message Scroller makes is a glide instead of a jump.
 *
 * Its moves — settling a sent message at the top, following the reply down —
 * all go through the viewport's `scrollTo`, and the only easing it offers is
 * the browser's `smooth`, whose duration is the browser's. So `scrollTo` is
 * wrapped on this one element: each call tweens `scrollTop` from where the view
 * is to where the scroller asked for, on `THREAD_GLIDE`. A call with a new
 * target while one is in flight retargets from the current position (the reply
 * grew), one with the same target is ignored (the scroller re-pinning its
 * anchor as the reply fills the room under it). The scroller still measures
 * real positions and still sees every scroll event, so its follow and release
 * logic is untouched.
 *
 * The reader always wins. Each frame the glide first checks that `scrollTop` is
 * still what it last wrote: a wheel lands on the scroller before its DOM event
 * reaches this thread, and a write in that gap would put the view back where
 * the glide wanted it and swallow the reader's scroll. Anything else moving it
 * ends the glide without a write; the wheel, touch, key and press listeners are
 * the same rule for input that has not scrolled anything yet.
 */
function useGlide(viewportRef: RefObject<HTMLDivElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!on || !viewport) return;

    let glide: AnimationPlaybackControls | null = null;
    let target = Number.NaN;
    /** where the glide last put the view, as the browser clamped it */
    let written = 0;
    const stop = () => {
      glide?.stop();
      glide = null;
      target = Number.NaN;
    };
    const native = HTMLElement.prototype.scrollTo;

    viewport.scrollTo = function scrollTo(
      this: HTMLElement,
      ...args: [ScrollToOptions?] | [number, number]
    ) {
      const [first, second] = args;
      const top = typeof first === "number" ? second : first?.top;
      const instant = typeof first === "object" && first.behavior === "instant";
      if (top === undefined || instant) {
        stop();
        Reflect.apply(native, this, args);
        return;
      }
      if (glide && Math.abs(top - target) <= 0.5) return;
      glide?.stop();
      target = top;
      written = viewport.scrollTop;
      glide = animate(written, top, {
        ...THREAD_GLIDE,
        onUpdate: (value) => {
          // moved by someone else since the last frame: the reader's now
          if (Math.abs(viewport.scrollTop - written) > 1) return stop();
          viewport.scrollTop = value;
          written = viewport.scrollTop;
        },
        onComplete: () => {
          glide = null;
          target = Number.NaN;
        },
      });
    } as typeof viewport.scrollTo;

    for (const type of TAKE_OVER) viewport.addEventListener(type, stop, { passive: true });
    return () => {
      stop();
      for (const type of TAKE_OVER) viewport.removeEventListener(type, stop);
      // back to the prototype's
      Reflect.deleteProperty(viewport, "scrollTo");
    };
  }, [on, viewportRef]);
}

export function AiThread({
  messages,
  streaming = false,
  enter = false,
}: {
  messages: readonly Message[];
  /** a reply is in flight: the empty assistant turn shimmers until it fills */
  streaming?: boolean;
  /** the thread is arriving under a send from the home box, so it fades and
   *  travels in; a chat opened with a history is simply there */
  enter?: boolean;
}) {
  const reduce = useReduced();
  const viewportRef = useRef<HTMLDivElement>(null);
  /* how long the thread was when it mounted: anything past that was said
     while it was on screen, and from then on its scrolling glides */
  const [landedLength] = useState(messages.length);
  useGlide(viewportRef, !reduce && (enter || messages.length > landedLength));

  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={0}
    >
      <MessageScroller>
        <MessageScrollerViewport
          ref={viewportRef}
          data-ai="thread"
          /* `scrollbar-none scrollbar-gutter-auto` replace the viewport's own
             `scrollbar-thin scrollbar-gutter-stable` in the class merge.
             NO_SCROLLBAR's arbitrary `[scrollbar-width:none]` is not seen as
             the same utility, so both stayed, `thin` won in the stylesheet,
             and Chrome draws a standard `scrollbar-width` over any
             `::-webkit-scrollbar` rule: a thin bar down the card's edge. */
          className={cn(NO_SCROLLBAR, "scrollbar-none scrollbar-gutter-auto")}
        >
          {/* the thread arrives as one body when a send docks the box; the
              first turn sits 24px under the header strip */}
          <MotionContent
            aria-label="Conversation"
            aria-busy={streaming}
            data-ai="thread-list"
            className={cn(THREAD_COLUMN, "mx-auto gap-3 py-6")}
            /* 24px of slack under the room the scroller makes below an
               anchored turn. The pending shimmer is 65px and a one-line
               reply 41: when the first token replaces it the thread is 24px
               shorter for a frame before the scroller re-measures, and with
               the view at its furthest scroll the browser would clamp it —
               the sent message dropping 24px and jumping back. */
            spacerClassName="box-content pb-6"
            variants={bodyVariants}
            initial={enter && !reduce ? "initial" : false}
            animate="animate"
            transition={timing(DURATION.move, reduce)}
          >
            <AnimatePresence initial={false}>
              {messages.map((message, index) => (
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
                    /* Laid out for real from the first frame. The scroller's
                       default is `content-visibility: auto`, which sizes every
                       turn not yet painted at a 160px guess — so the landing
                       measured on mount was against guesses, and the view
                       jumped a frame later when the real heights came in. */
                    "max-w-[76%] [content-visibility:visible]",
                    message.role === "user" ? "self-end" : "self-start",
                    // an exchange starts 24px off the one before it, so an
                    // anchored turn shows nothing of it (see the header)
                    message.role === "user" && index > 0 && "mt-3",
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
        <LandOnLastAnchor viewportRef={viewportRef} skip={streaming} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
