"use client";

import { useEffect, useState } from "react";

import { WORLD_POLL_MS, worldEndpoint, type WorldRecord } from "@/lib/worlds";

/**
 * A chat's World Labs world from `/api/world/chat/:chatId`: `undefined` until
 * the first answer, `null` when the chat has none. Asked again every
 * WORLD_POLL_MS while there is none yet (`watchEmpty`) or it is generating,
 * and never again once it is ready or failed.
 */
export function useWorld(chatId: string | null | undefined, { watchEmpty = false }: { watchEmpty?: boolean } = {}) {
  const [state, setState] = useState<{ chatId: string | null; world: WorldRecord | null | undefined }>({
    chatId: chatId ?? null,
    world: undefined,
  });

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const tick = async () => {
      let next: WorldRecord | null | undefined;
      try {
        const response = await fetch(worldEndpoint(chatId), { cache: "no-store", signal: controller.signal });
        if (response.ok) next = ((await response.json()) as { world?: WorldRecord | null }).world ?? null;
      } catch {
        /* offline or aborted: keep what we had */
      }
      if (cancelled) return;
      if (next !== undefined) setState({ chatId, world: next });
      const again = next === undefined || next?.status === "generating" || (next === null && watchEmpty);
      if (again) timer = setTimeout(tick, WORLD_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [chatId, watchEmpty]);

  return state.chatId === (chatId ?? null) ? state.world : undefined;
}
