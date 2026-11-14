import { AiPane } from "@/components/ai/pane";
import { Shell } from "@/components/shell";
import { defaultView } from "@/lib/navigation";

/** `/` — the AI app: the shell with the conversation pane as its content card. */
export default function Page() {
  return <Shell view={defaultView()} content={<AiPane />} />;
}
