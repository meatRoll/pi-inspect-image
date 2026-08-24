import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInspectImageTool } from "./inspect-image";
import { registerVisionCommand } from "./commands";

/**
 * pi-inspect-image extension entry point.
 *
 * Adds:
 *  - `inspect_image` tool — analyze local image files, pasted attachments, or
 *    data URLs through a vision-capable model.
 *  - `/vision` command — set the vision model used by inspect_image from
 *    inside the session (interactive picker, direct pattern, show, clear).
 *
 * Action methods (registerTool/registerCommand/…) cannot be called during
 * extension loading (the extension runtime is not initialized yet), so
 * registration happens on the first `session_start`, when tools refresh
 * immediately in the session.
 */
export default function (pi: ExtensionAPI): void {
  let registered = false;
  pi.on("session_start", async () => {
    if (registered) return;
    registered = true;
    registerInspectImageTool(pi);
    registerVisionCommand(pi);
  });
}