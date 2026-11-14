"use client";

/**
 * What is under the composer on the home screen.
 *
 * Not a flat row of example prompts: three different *kinds* of thing live here
 * — what you have already asked (Chats), what asks on your behalf (Routines),
 * and what you could ask next (Suggested tasks) — which is why the first two are
 * a tab pair and the third is a section of its own rather than nine cards in a
 * row.
 *
 * Everything is inert except the two tabs, the chat cards and "Use this prompt".
 * There is no agent, so a routine that could be switched off would be a switch
 * on nothing. The empty slots say so with a dashed outline, which is the shape
 * of something that is not there yet.
 *
 * ── Geometry ─────────────────────────────────────────────────────────────────
 * Every number is the source screen's scaled by 0.845 (see `tokens.ts`): the
 * 92px card floor becomes 78, the 10px gutter becomes 8, 13.5/12.5px type
 * becomes 13/12. The column is `COLUMN`, so the cards share the composer's left
 * and right edges exactly.
 */

import { ArrowUpRight, ChevronRight, MessageCircle, Zap } from "lucide-react";
import { useState } from "react";

import { COLUMN, FOCUS_RING } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Chat } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

/** The card face every real card on this screen shares. */
const CARD =
  "rounded-[10px] border border-plane-border bg-white p-3 text-left transition-colors";

/**
 * A slot with nothing in it.
 *
 * Dashed, and it deliberately does *not* wear the card's solid hairline: a
 * border is what a surface is drawn with, and an empty slot is a hole in the
 * page rather than a thing on it.
 */
const EMPTY_SLOT = cn(
  "flex min-h-[78px] items-center justify-center rounded-[10px] px-3 text-center",
  "border border-dashed border-plane-border-strong text-[12px] leading-[16px] text-[var(--ai-muted)]",
);

/** The tab pair, as a segmented pill. `spacing={1}` and not 0: at 0 the recipe
 *  turns the items into a segmented control with shared corners, and these are
 *  two separate pills on a shared row. */
const TAB = cn(
  "h-7 min-w-0 gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] leading-none font-normal",
  "border-transparent bg-transparent text-[var(--ai-muted)] hover:bg-[var(--ai-tint)]",
  "data-[pressed]:border-plane-border data-[pressed]:bg-[var(--ai-tint)] data-[pressed]:text-[var(--ai-ink)]",
);

/**
 * The three suggestions, and the sentence each one puts in the composer.
 *
 * `prompt` is deliberately not `title` — the card is a label and what it types
 * is a request. The gradients are house greys rather than saturated thumbnails:
 * this palette has one blue in it and it is spent on the primary button, so
 * three coloured rectangles would be the loudest thing on a screen whose whole
 * argument is that it is quiet.
 */
const SUGGESTED: {
  title: string;
  description: string;
  prompt: string;
  gradient: string;
}[] = [
  {
    title: "Research a topic",
    description:
      "Gather sources on a question and summarise where they agree and where they differ.",
    prompt: "Research this topic and summarise the main findings with sources:",
    gradient: "linear-gradient(135deg,#F4F4F5 0%,#E6E7EA 100%)",
  },
  {
    title: "Summarise a document",
    description:
      "Pull out the key points, decisions and open questions from a long document.",
    prompt: "Summarise this document's key points, decisions and open questions",
    gradient: "linear-gradient(135deg,#F2F1EF 0%,#E8E5E1 100%)",
  },
  {
    title: "Compare options",
    description:
      "Lay out two or more options side by side with their trade-offs and a recommendation.",
    prompt: "Compare these options side by side and recommend one:",
    gradient: "linear-gradient(135deg,#EFF0F1 0%,#E3E5E2 100%)",
  },
];

/** The one routine there is, which is one more than there are routines. */
const ROUTINE = {
  cadence: "Every Monday 9AM",
  title: "Weekly research digest",
};

/** The bolt tile a routine and a suggestion are both marked with. */
function BoltTile({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-[8px] bg-[var(--ai-chip)] text-[var(--ai-ink)]",
        className,
      )}
    >
      <Zap size={14} strokeWidth={1.75} />
    </span>
  );
}

/**
 * "2 hours ago", without a date library.
 *
 * The repo carries no date formatter and one card's caption is not worth a
 * dependency. Under a minute is "Just now" rather than "0 seconds ago": a chat
 * you have just sent is the row on this screen most likely to be read, and a
 * counter that says "3 seconds ago" and then "12 seconds ago" is a clock where
 * a label belongs.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "Just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86_400, "day"],
    [604_800, "week"],
    [2_592_000, "month"],
    [31_536_000, "year"],
  ];
  let chosen = units[0];
  for (const unit of units) if (seconds >= unit[0]) chosen = unit;
  const n = Math.floor(seconds / chosen[0]);
  return `${n} ${chosen[1]}${n === 1 ? "" : "s"} ago`;
}

export function AiHomeCards({
  chats,
  onUsePrompt,
  onOpenChat,
}: {
  /** The session's own conversations, newest first. */
  chats: readonly Chat[];
  /** Fills the composer. The pane owns the field, so this screen asks. */
  onUsePrompt: (prompt: string) => void;
  onOpenChat: (id: string) => void;
}) {
  const [tab, setTab] = useState<"chats" | "routines">("chats");

  return (
    <div data-ai="home-cards" className={cn(COLUMN, "mx-auto pt-6 pb-6")}>
      {/* The tab row, and the link that is not a tab. Both on one line, which is
          what makes the link read as belonging to the group rather than to the
          cards under it. */}
      <div className="flex items-center gap-1">
        <ToggleGroup
          aria-label="Agent home"
          value={[tab]}
          onValueChange={(next: string[]) => {
            // A segmented pair: pressing the pressed one leaves it pressed
            // rather than clearing the row to nothing selected.
            const picked = next.find((v) => v !== tab);
            if (picked === "chats" || picked === "routines") setTab(picked);
          }}
          spacing={1}
          className="gap-1 rounded-[8px]"
        >
          <ToggleGroupItem value="chats" className={TAB}>
            <MessageCircle className="size-[15px]" strokeWidth={1.75} />
            Chats
            {/* The chip grey the rest of the card counts in, never a colour: a
                count is how many, not how urgent. */}
            <span className="ml-0.5 rounded-[5px] bg-[var(--ai-chip)] px-1.5 py-0.5 text-[10.5px] leading-none text-[var(--ai-ink)]">
              {chats.length}
            </span>
          </ToggleGroupItem>
          <ToggleGroupItem value="routines" className={TAB}>
            <Zap className="size-[15px]" strokeWidth={1.75} />
            Routines
          </ToggleGroupItem>
        </ToggleGroup>

        {/* Inert, and drawn as a link rather than as a pill so it does not read
            as a third tab. There is no All Routines screen to go to. */}
        <Button
          variant="ghost"
          className={cn(
            "ml-auto h-7 gap-0.5 rounded-md border-0 px-1.5 text-[12.5px] leading-none font-normal",
            "text-[var(--ai-muted)] hover:bg-transparent hover:text-[var(--ai-ink)]",
            FOCUS_RING,
          )}
        >
          All Routines
          <ChevronRight className="size-[13px]" strokeWidth={2} />
        </Button>
      </div>

      <div
        role="group"
        aria-label={tab === "chats" ? "Chats" : "Routines"}
        className="mt-3 grid grid-cols-3 gap-2"
      >
        {tab === "chats"
          ? [0, 1, 2].map((slot) => {
              const chat = chats[slot];
              return chat === undefined ? (
                <div
                  key={`empty-${slot}`}
                  data-slot="empty"
                  className={EMPTY_SLOT}
                >
                  {slot === 0 && chats.length === 0
                    ? "Your chats will show up here"
                    : null}
                </div>
              ) : (
                /* The card opens the chat. A card showing a real conversation's
                   title that could not be pressed would be the one thing on this
                   screen that looks like a control and is not. */
                <Button
                  key={chat.id}
                  data-chat-card={chat.id}
                  variant="ghost"
                  onClick={() => onOpenChat(chat.id)}
                  className={cn(
                    CARD,
                    "h-auto min-h-[78px] flex-col items-start justify-start whitespace-normal",
                    "font-normal hover:bg-[var(--ai-tint)]",
                    FOCUS_RING,
                  )}
                >
                  <span className="line-clamp-2 text-[13px] leading-[18px] font-medium text-[var(--ai-ink)]">
                    {chat.title}
                  </span>
                  <span className="mt-2 text-[11.5px] leading-none text-[var(--ai-muted)]">
                    {relativeTime(chat.updatedAt)}
                  </span>
                </Button>
              );
            })
          : [
              <div
                key="routine"
                data-routine-card
                className={cn(CARD, "min-h-[78px]")}
              >
                <div className="flex items-start gap-2">
                  <BoltTile />
                  {/* Ink on the chip grey, which is how this card says "on"
                      without reaching for a green. */}
                  <span className="ml-auto rounded-full bg-[var(--ai-chip)] px-2 py-[3px] text-[10.5px] leading-none font-medium text-[var(--ai-ink)]">
                    Active
                  </span>
                </div>
                <p className="mt-2 text-[11.5px] leading-none text-[var(--ai-muted)]">
                  {ROUTINE.cadence}
                </p>
                <p className="mt-1.5 text-[13px] leading-[18px] font-medium text-[var(--ai-ink)]">
                  {ROUTINE.title}
                </p>
              </div>,
              <div key="empty-1" data-slot="empty" className={EMPTY_SLOT} />,
              <div key="empty-2" data-slot="empty" className={EMPTY_SLOT} />,
            ]}
      </div>

      <h2 className="mt-6 text-[12px] leading-none font-medium text-[var(--ai-muted)]">
        Suggested tasks
      </h2>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {SUGGESTED.map(({ title, description, prompt, gradient }) => (
          /* A card and not a button, because only one thing inside it acts.
             Making the whole card pressable would put a 200px hit target on a
             screen where the pill inside it is the affordance — and would give
             the card a hover wash *and* the pill one, which is two washes for
             one pointer. */
          <div
            key={title}
            data-suggested-card
            className={cn(CARD, "flex flex-col p-0")}
          >
            <div
              aria-hidden
              className="grid h-[76px] place-items-center rounded-t-[9px]"
              style={{ backgroundImage: gradient }}
            >
              <BoltTile className="bg-white/70" />
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <p className="text-[13px] leading-none font-medium text-[var(--ai-ink)]">
                {title}
              </p>
              <p className="mt-1.5 line-clamp-2 text-[12px] leading-[16px] text-[var(--ai-muted)]">
                {description}
              </p>
              <Button
                variant="outline"
                onClick={() => onUsePrompt(prompt)}
                className={cn(
                  "mt-3 h-7 w-fit gap-1 rounded-lg border-plane-border-strong bg-white px-2.5",
                  "text-[11.5px] leading-none font-medium text-[var(--ai-muted)]",
                  "hover:bg-[var(--ai-tint)] hover:text-[var(--ai-ink)]",
                  FOCUS_RING,
                )}
              >
                Use this prompt
                <ArrowUpRight className="size-[13px]" strokeWidth={2} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
