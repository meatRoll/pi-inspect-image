/**
 * `/vision` slash command — set the vision model used by inspect_image
 * from inside a pi session.
 *
 * Usage:
 *   /vision                  pick a vision model interactively
 *   /vision <pattern>        set directly (provider/id, exact id, or fuzzy id)
 *   /vision show             show the current configured default
 *   /vision clear            clear the configured default (automatic routing)
 *
 * The selection is persisted to ~/.pi/agent/inspect-image.json as
 * `defaultModel`, which inspect_image reads on every call.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  configFilePath,
  describeConfigSource,
  loadInspectImageConfig,
  setDefaultVisionModel,
} from "./config";
import { findModelById } from "./model-select";

function formatModelName(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export function registerVisionCommand(pi: ExtensionAPI): void {
  pi.registerCommand("vision", {
    description:
      "Set the vision model used by inspect_image. Usage: /vision [show|clear|<model pattern>] — no argument opens an interactive picker.",
    handler: async (args, ctx) => {
      const registry = ctx.modelRegistry;
      const visionModels = registry
        .getAvailable()
        .filter((m) => m.input.includes("image"))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

      const trimmed = args?.trim() ?? "";

      if (trimmed === "show") {
        // Load fresh from disk: the module-level cache is empty on a new
        // session until something calls loadInspectImageConfig(), which made
        // a persisted default look "gone" right after restarting pi.
        await loadInspectImageConfig();
        const source = describeConfigSource();
        if (source.defaultModel) {
          ctx.ui.notify(
            `inspect_image vision model: ${source.defaultModel} (from ${configFilePath()})`,
            "info",
          );
        } else {
          ctx.ui.notify(
            "inspect_image vision model: automatic routing is active. Available: " +
              (visionModels.length
                ? visionModels.map((m) => formatModelName(m.provider, m.id)).join(", ")
                : "none (no vision-capable models registered)"),
            "info",
          );
        }
        return;
      }

      if (trimmed === "clear") {
        await setDefaultVisionModel(null);
        ctx.ui.notify("inspect_image vision model reset — automatic routing is active.", "info");
        return;
      }

      if (trimmed) {
        const found = findModelById(registry, trimmed);
        if (!found || !found.input.includes("image")) {
          ctx.ui.notify(
            `Could not resolve a vision-capable model for "${trimmed}". ` +
              `Run /vision (no argument) to pick from the available vision models.`,
            "error",
          );
          return;
        }
        await setDefaultVisionModel(formatModelName(found.provider, found.id));
        ctx.ui.notify(
          `inspect_image will now use vision model ${formatModelName(found.provider, found.id)}.`,
          "info",
        );
        return;
      }

      // Interactive picker. Needs UI (TUI/RPC); print mode falls back to an error.
      if (!ctx.hasUI || !ctx.ui.select) {
        ctx.ui.notify(
          "Interactive /vision picking requires the TUI. Run e.g. `/vision Auto-Multi` or `/vision show`.",
          "error",
        );
        return;
      }

      if (visionModels.length === 0) {
        ctx.ui.notify("No vision-capable models are registered. Add one with `input: [\"text\", \"image\"]`.", "error");
        return;
      }

      await loadInspectImageConfig();
      const current = describeConfigSource().defaultModel;
      const items = [
        ...(current ? [`${current} (current)`] : []),
        "(auto) automatic routing",
        ...visionModels.map((m) => formatModelName(m.provider, m.id)),
      ];
      const choice = await ctx.ui.select(
        "Select the vision model for inspect_image:",
        items,
      );
      if (!choice) {
        ctx.ui.notify("Vision model selection cancelled.", "info");
        return;
      }
      if (choice.startsWith("(auto)")) {
        await setDefaultVisionModel(null);
        ctx.ui.notify("inspect_image vision model reset — automatic routing is active.", "info");
        return;
      }
      const label = choice.replace(" (current)", "");
      await setDefaultVisionModel(label);
      ctx.ui.notify(`inspect_image will now use vision model ${label}.`, "info");
    },
  });
}

export type VisionCommandContext = ExtensionCommandContext;