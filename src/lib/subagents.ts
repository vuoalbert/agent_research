/**
 * Subagents — the shape both sides of `deploy_subagents` agree on.
 *
 * The route (src/app/api/chat/subagents.ts) runs a few research subagents in
 * parallel and reports them as ONE `tool` row, `action: "subagents"`, whose
 * `subagents` list it re-sends as each one progresses. Each subagent's own
 * searches and reads are ordinary `tool` rows tagged with `parentId` (the
 * group's id) and `agentId` (the subagent's id): their sources reach the store
 * like any other, and the thread draws them inside the group.
 */

/** one per subagent, in the order they were deployed */
export const SUBAGENT_SHAPES = ["square", "circle", "triangle", "diamond", "hexagon"] as const;
export type SubagentShape = (typeof SUBAGENT_SHAPES)[number];

export type SubagentStatus = "running" | "done" | "error";

export type Subagent = {
  id: string;
  title: string;
  shape: SubagentShape;
  status: SubagentStatus;
  /** its latest activity while running ("Searching …"), then its one-line result */
  line: string;
  /** epoch ms; absent while it waits for a free slot */
  startedAt?: number;
  finishedAt?: number;
};

/** the model every subagent runs on, as the thread labels it */
export const SUBAGENT_MODEL_LABEL = "Opus 5.5";

export const shapeAt = (index: number): SubagentShape => SUBAGENT_SHAPES[index % SUBAGENT_SHAPES.length];

/** a `subagents` list off the wire (or out of localStorage), with anything malformed dropped */
export function parseSubagents(value: unknown): Subagent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: Subagent[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.title !== "string") return;
    list.push({
      id: raw.id,
      title: raw.title,
      shape: SUBAGENT_SHAPES.includes(raw.shape as SubagentShape) ? (raw.shape as SubagentShape) : shapeAt(index),
      status: raw.status === "done" || raw.status === "error" ? raw.status : "running",
      line: typeof raw.line === "string" ? raw.line : "",
      ...(typeof raw.startedAt === "number" ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.finishedAt === "number" ? { finishedAt: raw.finishedAt } : {}),
    });
  });
  return list;
}
