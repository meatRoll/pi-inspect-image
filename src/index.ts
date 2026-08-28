/**
 * pi-inspect-image extension entry point.
 *
 * Adds:
 *  - `inspect_image` tool — analyze local image files, pasted attachments, or
 *    data URLs through a vision-capable model.
 *  - `/vision` command — set the vision model used by inspect_image from
 *    inside the session (interactive picker, direct pattern, show, clear).
 *
 * The tool is registered once on the first `session_start` (action methods
 * cannot be called during extension loading), but it is only *active* when the
 * session's current model cannot accept image input itself. When the main
 * model is vision-capable the tool is removed from the active tool set so it
 * does not appear in the model's tool list; `model_select` re-syncs the active
 * set whenever the user switches models.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
type AnyModel = Model<Api>;
import { loadInspectImageConfig } from "./config";
import { registerInspectImageTool } from "./inspect-image";
import { isVisionCapable } from "./model-select";
import { registerVisionCommand } from "./commands";

const TOOL_NAME = "inspect_image";

/**
 * Keep `inspect_image` in the active tool set exactly when the current model
 * cannot process images itself. No-op when the state already matches.
 */
function syncToolActivation(pi: ExtensionAPI, model: AnyModel | undefined): void {
  const active = pi.getActiveTools();
  const isListed = active.includes(TOOL_NAME);
  if (isVisionCapable(model)) {
    if (isListed) pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
  } else if (!isListed) {
    pi.setActiveTools([...active, TOOL_NAME]);
  }
}

export default function (pi: ExtensionAPI): void {
  let registered = false;
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Prime the config cache so `/vision show` and the interactive picker
    // reflect the persisted default from the very first command of a session
    // (cache is module-local and empty until first load).
    await loadInspectImageConfig().catch(() => {});
    if (!registered) {
      registered = true;
      registerInspectImageTool(pi);
      registerVisionCommand(pi);
    }
    // Deactivate inspect_image when the main model handles images itself.
    syncToolActivation(pi, ctx.model);
  });

  // Re-sync when the user switches models mid-session (e.g. /model, Ctrl+P,
  // or session restore). Registered-but-inactive tools are invisible to the
  // model, so toggling activation is enough — no re-registration needed.
  pi.on("model_select", async (event, ctx) => {
    syncToolActivation(pi, event.model ?? ctx.model);
  });

  // Fallback for the one-turn lag of mid-session setActiveTools changes: the
  // next request's tool snapshot may already have been taken when model_select
  // fires, leaving a stale inspect_image visible for exactly one turn. Re-sync
  // here, immediately before each agent loop, so the request is always built
  // from the correct tool set.
  pi.on("before_agent_start", async (_event, ctx) => {
    syncToolActivation(pi, ctx.model);
  });
}
