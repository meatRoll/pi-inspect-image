/**
 * inspect_image tool implementation for pi.
 * Adapted from oh-my-pi's packages/coding-agent/src/tools/inspect-image.ts,
 * re-implemented on pi's extension API (registerTool + ModelRegistry).
 */
import { Type } from "typebox";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  collectTurnImageAttachments,
  loadImageInput,
  MAX_IMAGE_INPUT_BYTES,
} from "./image-loading";
import { resolveModelAuth, resolveVisionModel } from "./model-select";
import { INSPECT_IMAGE_DESCRIPTION, INSPECT_IMAGE_SYSTEM_PROMPT } from "./prompts";

const inspectImageSchema = Type.Object({
  path: Type.String({
    description:
      "Image file path (resolved relative to the session cwd), Image #N attachment label, attachment://N / image://N URI, or data:image/...;base64,... URL.",
  }),
  question: Type.String({ description: "Question about the image, with constraints or output format." }),
  model: Type.Optional(
    Type.String({
      description:
        "Optional vision model override, e.g. 'anthropic/claude-sonnet-4-5' or a bare model id. Defaults to the active model if it supports images, otherwise the best available vision model.",
    }),
  ),
  autoResize: Type.Optional(
    Type.Boolean({
      description:
        "Whether to downscale/re-encode oversized images before upload (default true; caps at 1568x1568 / ~500 KiB).",
    }),
  ),
});

export type InspectImageParams = {
  path: string;
  question: string;
  model?: string;
  autoResize?: boolean;
};

export interface InspectImageToolDetails {
  model: string;
  imagePath: string;
  mimeType: string;
  resized: boolean;
  bytes: number;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function extractTextContent(response: AssistantMessage): string {
  const texts: string[] = [];
  for (const part of response.content) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("").trim();
}

function timeoutMessage(timeoutMs: number): string {
  const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
  return `inspect_image request timed out after ${seconds}s. Set a larger timeout (call with a longer timeout or check the vision model provider).`;
}

export function createInspectImageTool(): ToolDefinition<typeof inspectImageSchema, InspectImageToolDetails> {
  return {
    name: "inspect_image",
    label: "InspectImage",
    description: INSPECT_IMAGE_DESCRIPTION,
    promptSnippet: "Describe or analyze an image file or pasted image via a vision-capable model",
    promptGuidelines: [
      "Use inspect_image for image understanding (OCR, screenshots, diagrams, photos) that the text-only conversation cannot see.",
      "For inspect_image, resolve `path` against the session cwd, or use `Image #N` / `attachment://N` to reference an image pasted into the current turn.",
    ],
    parameters: inspectImageSchema,
    async execute(
      _toolCallId: string,
      params: InspectImageParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<InspectImageToolDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const registry = ctx.modelRegistry;

      const selection = resolveVisionModel(registry, ctx.model, params.model);
      if (!selection) {
        throw new Error(
          "inspect_image: no vision-capable model is available. Configure a vision-capable model in pi (model catalogue, provider, or `images` support) and retry.",
        );
      }
      const { model } = selection;

      const auth = await resolveModelAuth(registry, model);

      const attachments = collectTurnImageAttachments(ctx.sessionManager.getBranch());
      const { input } = await loadImageInput({
        path: params.path,
        cwd: ctx.cwd,
        attachments,
        autoResize: params.autoResize ?? true,
        maxBytes: MAX_IMAGE_INPUT_BYTES,
      });
      if (!input) {
        throw new Error(
          "inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.",
        );
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Inspecting ${input.resolvedPath} [${input.mimeType}] via ${model.provider}/${model.id}…`,
          },
        ],
        details: {
          model: `${model.provider}/${model.id}`,
          imagePath: input.resolvedPath,
          mimeType: input.mimeType,
          resized: input.wasResized,
          bytes: input.bytes,
          width: input.width,
          height: input.height,
          originalWidth: input.originalWidth,
          originalHeight: input.originalHeight,
        },
      });

      const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      const effectiveSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const timedOut = (): boolean => timeoutSignal.aborted && !signal?.aborted;

      let response: AssistantMessage;
      try {
        response = await registry.complete(model, {
          systemPrompt: INSPECT_IMAGE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", data: input.data, mimeType: input.mimeType },
                { type: "text", text: params.question },
              ],
              timestamp: Date.now(),
            },
          ],
        }, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: effectiveSignal,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxTokens: 4096,
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
          if (timedOut()) throw new Error(timeoutMessage(DEFAULT_TIMEOUT_MS));
        }
        throw error;
      }

      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "inspect_image request failed.");
      }
      if (response.stopReason === "aborted") {
        if (timedOut()) throw new Error(timeoutMessage(DEFAULT_TIMEOUT_MS));
        throw new Error("inspect_image request aborted.");
      }

      const text = extractTextContent(response);
      if (!text) {
        throw new Error("inspect_image model returned no text output.");
      }

      return {
        content: [{ type: "text", text }],
        details: {
          model: `${model.provider}/${model.id}`,
          imagePath: input.resolvedPath,
          mimeType: input.mimeType,
          resized: input.wasResized,
          bytes: input.bytes,
          width: input.width,
          height: input.height,
          originalWidth: input.originalWidth,
          originalHeight: input.originalHeight,
        },
      };
    },
  };
}

/** Register the inspect_image tool (idempotent). */
export function registerInspectImageTool(pi: ExtensionAPI): void {
  // registerTool refreshes tools in-session; calling an already-registered name
  // would shadow built-ins, so guard against duplicate registration on /reload.
  const existing = pi.getAllTools().find((t) => t.name === "inspect_image");
  if (existing?.sourceInfo.source === "builtin") return;
  pi.registerTool(createInspectImageTool());
}