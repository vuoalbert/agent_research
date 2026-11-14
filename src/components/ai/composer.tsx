"use client";

/**
 * The composer: one element, two shapes.
 *
 * At home it is a 760px box a third of the way down the pane with a brand mark
 * dissolving behind it; with a conversation open it is an 840px bar at the
 * foot of the thread. It is **one** `PromptInput` in both, moved by Motion's
 * `layoutId` — a second instance would take the caret, the selection and the
 * focus with it every time the screen changed.
 *
 * `layoutId` rather than `layout` because that is the honest description: this
 * is one object in two places, and the id says so.
 */

import { ChevronUp, Mic, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, type KeyboardEvent } from "react";

import { RibbonMark } from "@/components/brand/ribbon";
import { AiPlusMenu } from "@/components/ai/plus-menu";
import { PromptInput } from "@/components/ai/prompt-input";
import {
  COLUMN,
  DOCK_COLUMN,
  DOCK_SWAP,
  FOCUS_RING,
  MARK_BLUR_MASK,
  MARK_BLUR_PX,
  MARK_CRISP_MASK,
  MARK_RISE,
  MARK_SIZE,
} from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The composer's small round buttons — the `+` and the microphone.
 *
 * One component rather than two, because two 32px ghost squares written out
 * twice is two chances for one of them to be 30. `border-0` because the
 * `Button` recipe's `border border-transparent` insets its glyph by a pixel.
 */
function GlyphButton({
  icon: Icon,
  label,
  ...props
}: {
  icon: typeof Plus;
  label: string;
} & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      {...props}
      className={cn(
        "size-8 shrink-0 rounded-lg border-0 text-[var(--ai-muted)]",
        "hover:bg-[var(--ai-tint)] hover:text-[var(--ai-ink)]",
        FOCUS_RING,
        props.className,
      )}
    >
      <Icon size={16} strokeWidth={1.75} />
    </Button>
  );
}

export function AiComposer({
  value,
  onValueChange,
  onSubmit,
  docked,
  streaming = false,
  onStop,
  transition = DOCK_SWAP,
}: {
  value: string;
  onValueChange: (next: string) => void;
  onSubmit: (text: string) => void;
  /** a reply is arriving: the chevron becomes a Stop */
  streaming?: boolean;
  onStop?: () => void;
  /** Which of the two screens this is. One boolean and not a mode, because it
   *  is not a choice anybody makes: a conversation either has something in it or
   *  it does not, and the pane owes the reader the layout that matches. */
  docked: boolean;
  transition?: React.ComponentProps<typeof motion.div>["transition"];
}) {
  /* The one control on this screen that reaches outside the app. A real
     `<input type="file">` rather than a pretend one — "Add files or photos" is
     the row in the `+` menu with something behind it, and a picker that never
     opened would be the eighth inert row wearing a shortcut. Nothing is done
     with what comes back, which is the truth about a composer with no agent
     behind it; the dialog opening is the whole of the promise. */
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = () => fileRef.current?.click();

  return (
    <motion.div
      layoutId="ai-composer"
      transition={transition}
      data-composer={docked ? "docked" : "home"}
      className={cn(
        "relative isolate z-10 shrink-0",
        docked ? DOCK_COLUMN : COLUMN,
      )}
    >
      <AnimatePresence initial={false}>
        {docked ? null : (
          /* Two thirds of a brand mark, and the third you cannot see is the
             point. The layer runs from MARK_RISE above this block to its bottom
             edge and the mark is pinned to the layer's top, so the mark's lower
             third lands behind the composer — the form is this block's only
             laid-out child. What is above that line is drawn, what is below is
             behind an opaque white box, and what would spill past the box's
             bottom is cut by the layer's own `overflow-hidden`.

             It fades rather than vanishing, and it is keyed so `AnimatePresence`
             can hold it for the length of that fade while the box beneath it is
             already on its way down. */
          <motion.div
            key="mark"
            aria-hidden
            /* The composer projects both size and position as it becomes the
               docked bar. This layer is its direct child, so opting it into
               projection lets Motion cancel the parent's temporary scale
               before it reaches the 600px SVG. `position` is deliberate: the
               ribbon is image-like and should keep its authored dimensions
               while it fades, not interpolate the layer's changing box.

               The layer widens around the pane's centre (760 -> 840). Anchor
               there so position-only correction does not turn that symmetric
               width change into a 40px horizontal drift. */
            layout="position"
            layoutAnchor={{ x: 0.5, y: 0 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
            style={{ top: -MARK_RISE }}
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 overflow-hidden"
          >
            {/* The same glyph twice, at the same size and the same place, each
                wearing the other's mask. Neither is decoration for the other:
                remove the crisp one and the mark is soft to its crown; remove
                the blurred one and it ends at a hard line just above the box.

                The mask and the blur ride a wrapper rather than the svg: they
                are this pane's treatment of the mark, not properties of the
                mark, and `RibbonMark` is shared with the rail and the switcher.
                `flat` for the same reason — the facet tints that carry the fold
                at 28px would read as grey steps across 600. */}
            <div
              data-mark="crisp"
              style={{
                maskImage: MARK_CRISP_MASK,
                WebkitMaskImage: MARK_CRISP_MASK,
              }}
              className="absolute top-0 left-1/2 -translate-x-1/2 text-plane-border opacity-90"
            >
              <RibbonMark size={MARK_SIZE} flat />
            </div>
            <div
              data-mark="blurred"
              style={{
                filter: `blur(${MARK_BLUR_PX}px)`,
                maskImage: MARK_BLUR_MASK,
                WebkitMaskImage: MARK_BLUR_MASK,
              }}
              className="absolute top-0 left-1/2 -translate-x-1/2 text-plane-border opacity-90"
            >
              <RibbonMark size={MARK_SIZE} flat />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <PromptInput
        value={value}
        onValueChange={onValueChange}
        onSubmit={onSubmit}
        loading={streaming}
        onStop={onStop}
        dock={docked}
        // One line docked, two at home. Both grow to `maxRows` and then scroll.
        minRows={docked ? 1 : 2}
        maxRows={docked ? 4 : 6}
        placeholder={docked ? "Write a message…" : "Ask Starline…"}
        aria-label={docked ? "Write a message" : "Ask Starline"}
        /* `bg-white` is opaque on purpose: the mark's lower half is behind this
           box at home and must stay unreadable through it. The focus affordance
           is the panel's own hairline darkening by one grey step, because the
           textarea is `outline-none` and an outline inside a bordered panel
           draws a second, smaller box. */
        className={cn(
          "relative z-10 border-plane-border-strong bg-white focus-within:border-[#C9CDD2]",
          "shadow-[0_1px_2px_rgba(15,15,16,0.04),0_8px_24px_rgba(15,15,16,0.06)]",
          docked
            ? // `min-h` and not `h`: 52px is the bar's resting height, not a cap.
              // A Shift+Enter in the docked bar grows the field to two lines, and
              // a fixed height would hide the second one.
              "flex min-h-[52px] items-center px-3 py-2"
            : "p-2",
        )}
        /* 16 docked, not 26. Half the height is a pill — two semicircles with a
           straight bit between them. This bar is a rounded *rectangle*: the
           corners read as arcs, and you can see where each one starts and stops.
           16 is also 12 plus one step, so the dock reads as the home box
           settling rather than as a different kind of object.

           A number rather than a `rounded-*` class, which is what lets it be
           animated (12 -> 16 across the move) and scale-corrected. */
        radius={docked ? 16 : 12}
        motionTransition={transition}
        /* Tone only. A `text-[...]` here would outrank the composer's own
           `text-sm leading-6`, bring its own leading with it, and leave the
           24px the measurement clamps against measuring something the field no
           longer is. */
        textareaClassName="text-[var(--ai-ink)] placeholder:text-[var(--ai-muted)]"
        sendClassName={
          docked
            ? "bg-transparent text-[var(--ai-muted)] hover:bg-[var(--ai-tint)] hover:text-[var(--ai-ink)] disabled:bg-transparent disabled:text-[var(--ai-line)] disabled:opacity-100"
            : "bg-[var(--ai-ink)] text-white hover:bg-[#33383C] disabled:bg-[var(--ai-chip)] disabled:text-[var(--ai-muted)] disabled:opacity-100"
        }
        sendIcon={docked ? <ChevronUp className="size-4" /> : undefined}
        leadingAction={
          <AiPlusMenu onAddFiles={addFiles}>
            <GlyphButton icon={Plus} label="Add to the conversation" />
          </AiPlusMenu>
        }
        trailingAction={
          docked ? <GlyphButton icon={Mic} label="Voice input" /> : undefined
        }
        /* ⌘U while the field has focus, which is the only place the shortcut
           means anything — a window listener would fire it from the sidebar and
           from a route two apps away. */
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "u"
          ) {
            event.preventDefault();
            addFiles();
          }
        }}
      />

      {/* Out of the tab order and out of the a11y tree: it is opened by the menu
          row and by ⌘U, and a bare file input in a composer is a control nobody
          asked for. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        aria-hidden
        tabIndex={-1}
        className="hidden"
      />
    </motion.div>
  );
}
