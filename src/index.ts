import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInspectImageTool } from "./inspect-image";

/**
 * pi-inspect-image extension entry point.
 *
 * Adds the `inspect_image` tool: sends a local image file, pasted attachment,
 * or data URL to a vision-capable model and returns its text analysis.
 *
 * Action methods (registerTool/…) cannot be called during extension loading
 * (the extension runtime is not initialized yet), so registration happens on
 * the first `session_start`, when tools refresh immediately in the session.
 */
export default function (pi: ExtensionAPI): void {
  let registered = false;
  pi.on("session_start", async () => {
    if (registered) return;
    registered = true;
    registerInspectImageTool(pi);
  });
}