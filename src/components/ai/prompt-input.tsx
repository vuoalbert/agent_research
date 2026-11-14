"use client";

/**
 * beui's agent composer — https://beui.dev/components/agents/prompt-input
 * (registry item `@beui/prompt-input`), copied in and trimmed to what this
 * tree already owns.
 *
 * ── Why copied and not `shadcn add`ed ────────────────────────────────────────
 * `npx shadcn@latest add @beui/prompt-input` was run against the configured
 * registry and it resolves — but the item ships twelve files, and installing it
 * **overwrites `src/lib/utils.ts`** (swapping this repo's `export { cn } from
 * "cn"` for a clsx + tailwind-merge implementation) and adds `clsx` and
 * `tailwind-merge` to `package.json`. Both are scaffold-owned files under
 * CONTRACT.md §5, and it also drops nine unrelated components — three button
 * flavours, a morph popover, a select — into `src/components/motion/`.
 * So: one file, copied, attributed here. The install was reverted.
 *
 * ── What is kept ─────────────────────────────────────────────────────────────
 * The part that is genuinely hard and that a hand-rolled textarea gets wrong:
 * the hidden measurement div that grows the field by whole lines without ever
 * reading `scrollHeight` off the live element (which can only ever grow), the
 * min/max row clamp, the Enter / Shift+Enter split with the IME guard, and the
 * send/stop swap.
 *
 * ── What changed on the way in ───────────────────────────────────────────────
 * - The send button is this repo's shadcn/Base UI `Button` rather than beui's
 *   `components/motion/button/base`; `border-0` on it because the recipe's
 *   `border border-transparent` insets a 32px icon button's glyph by a pixel.
 * - `SPRING_SWAP` is inlined rather than imported from the `@/lib/ease` the
 *   registry would have written, which is one constant against one more file.
 * - The model `Select` and the `MorphPopover` action menu are dropped, as they
 *   were in the screen this reproduces: there is one model and no popover
 *   grammar in this tree. Both slots come back as `leadingAction` /
 *   `trailingAction`, so the caller supplies the house's own controls and this
 *   file stays a composer.
 */

import { ArrowUp, Square } from "lucide-react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { cn } from "@/lib/utils";

/** Content swaps — the send glyph trading places with the stop square. */
const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 30,
  mass: 0.55,
} as const;

/** The leading the measurement and the clamp are both written against. Change
 *  this and every `minRows`/`maxRows` in the app means something else. */
const LINE_HEIGHT = 24;

export interface PromptInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (value: string) => void | Promise<void>;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  /** The bottom row's left cluster — here, the `+`. */
  leadingAction?: ReactNode;
  /** The bottom row's right cluster, before the send button. */
  trailingAction?: ReactNode;
  /**
   * The one-line form of this composer.
   *
   * Not a second component and not a second instance. The docked bar and the
   * centred box are the same `<textarea>` — the caller animates between them
   * with one Motion layout, and a remount would take the caret, the selection
   * and the focus with it. So the DOM is identical in both and only `order` and
   * the flex direction move: field over controls when it is a box, `+` | field |
   * controls when it is a bar.
   */
  dock?: boolean;
  /** What the send button shows. The bar wants a chevron where the box wants an
   *  arrow, and that is the whole of the difference. */
  sendIcon?: ReactNode;
  className?: string;
  /** The field's own classes, merged rather than replaced: the tones are the
   *  caller's, the geometry the measurement depends on is not. */
  textareaClassName?: string;
  /** The send button's classes. Same split. */
  sendClassName?: string;
  /**
   * The corner, as a number rather than a class, and the difference is visible.
   *
   * When a caller animates this composer between two boxes with Motion's
   * `layout`, the box is *scaled* from its old size to its new one for the
   * length of the move — and a `rounded-*` class applied to a box being held at
   * `scaleY: 1.9` paints an ellipse. Motion corrects `borderRadius` only when it
   * can read it as a style, and animates it only when it is a value. So it is a
   * number, it is on `style`, and it is in `animate`.
   */
  radius?: number;
  /** The transition the caller is moving this composer under, so the corner and
   *  the counter-scaled children travel on the same curve as the box. */
  motionTransition?: Transition;
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  trailingAction,
  dock = false,
  sendIcon,
  radius,
  motionTransition,
  className,
  textareaClassName,
  sendClassName,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onKeyDown,
  ...textareaProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const currentValue = value ?? internalValue;
  const canSubmit = Boolean(currentValue.trim()) && !disabled && !loading;

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measurement = measurementRef.current;
    if (!textarea || !measurement || textarea.value !== currentValue) return;

    const nextHeight = Math.min(
      Math.max(measurement.scrollHeight, minRows * LINE_HEIGHT),
      maxRows * LINE_HEIGHT,
    );
    const height = `${nextHeight}px`;
    if (textarea.style.height !== height) textarea.style.height = height;
  }, [currentValue, maxRows, minRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    if (!prompt || disabled || loading) return;

    onSubmit?.(prompt);
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    /* `motion.form` with `layout`, because the box this composer is drawn in
       genuinely changes size between the caller's two screens and Motion has to
       measure it to move it. Everything *inside* is `layout="position"`: that is
       the opt-out from the parent's scale — Motion counter-scales a layout child
       so it renders at its own size and only travels — and without it the
       placeholder, the two icon clusters and the send button are all stretched
       by however much the box is. */
    <motion.form
      layout
      transition={motionTransition}
      initial={false}
      animate={radius === undefined ? undefined : { borderRadius: radius }}
      style={radius === undefined ? undefined : { borderRadius: radius }}
      onSubmit={submit}
      className={cn(
        "relative w-full border p-2 transition-colors",
        radius === undefined && "rounded-2xl",
        disabled && "opacity-60",
        className,
      )}
    >
      {/* One flex row, two arrangements. `order` and `flex-wrap` do the moving,
          so the field and both control clusters keep their places in the DOM and
          React never has cause to remount the `<textarea>` under an animation.

          `w-full` is not decoration: docked, the caller's `className` makes the
          *form* a flex row so the bar can centre its contents vertically — which
          turns this container into a flex item, sized to its own content unless
          told otherwise. The field's `flex-1` would then have nothing to grow
          inside, and the mic and the chevron would sit hard against the
          placeholder instead of at the far right of the bar. */}
      <motion.div
        layout="position"
        transition={motionTransition}
        className={cn(
          "flex w-full gap-x-1 gap-y-1",
          dock ? "items-center" : "flex-wrap items-center",
        )}
      >
        <motion.div
          layout="position"
          transition={motionTransition}
          className={cn(
            "relative",
            dock ? "order-2 min-w-0 flex-1" : "order-1 w-full",
          )}
        >
          {/* The field's height, measured on a copy. Reading `scrollHeight` off
              the textarea itself only ever grows it — a shrunk value is hidden
              behind the height already set — so the text is laid out a second
              time, invisibly, at the same width and leading. The zero-width
              space keeps a trailing newline from being collapsed away.

              Inside the field's own wrapper rather than the form's, which is
              what makes the docked bar measure correctly: there the field is a
              `flex-1` between two 32px buttons, and a copy laid out at the
              *form's* width would wrap later than the field does — the height
              would come back too short and the overflow would be hidden. */}
          <div
            ref={measurementRef}
            aria-hidden="true"
            className={cn(
              "pointer-events-none invisible absolute inset-x-0 top-0 px-2 text-sm leading-6 whitespace-pre-wrap [overflow-wrap:break-word]",
              textareaClassName,
            )}
          >
            {`${currentValue}\u200b`}
          </div>
          <textarea
            ref={textareaRef}
            value={currentValue}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={ariaLabel}
            rows={minRows}
            {...textareaProps}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              "block w-full resize-none overflow-y-auto bg-transparent px-2 text-sm leading-6 outline-none",
              NO_SCROLLBAR,
              dock ? "py-0" : "pt-1.5",
              textareaClassName,
            )}
          />
        </motion.div>

        {leadingAction ? (
          <motion.div
            layout="position"
            transition={motionTransition}
            className={cn(
              "flex shrink-0 items-center",
              dock ? "order-1" : "order-2 min-h-8",
            )}
          >
            {leadingAction}
          </motion.div>
        ) : null}

        <motion.div
          layout="position"
          transition={motionTransition}
          className={cn(
            "flex shrink-0 items-center gap-1",
            dock ? "order-3" : "order-3 ml-auto min-h-8",
          )}
        >
          {trailingAction}
          <Button
            type={loading ? "button" : "submit"}
            size="icon"
            disabled={loading ? !onStop : !canSubmit}
            aria-label={loading ? "Stop generating" : "Send prompt"}
            onClick={loading ? onStop : undefined}
            className={cn("size-8 rounded-full border-0", sendClassName)}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={loading ? "stop" : "send"}
                initial={
                  reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }
                }
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className="grid place-items-center"
              >
                {loading ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  (sendIcon ?? <ArrowUp className="size-4" />)
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </motion.div>
      </motion.div>
    </motion.form>
  );
}
