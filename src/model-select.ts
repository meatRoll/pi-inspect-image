/**
 * Vision-capable model selection and auth for inspect_image.
 *
 * Mirrors oh-my-pi's `@vision` role resolution with a heuristic fallback:
 * the current active model wins when it accepts image input; otherwise the
 * best-scoring vision model from the registered catalogue is used. Callers can
 * pin a specific model with `provider/modelId` or a bare model id.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
type AnyModel = Model<Api>;
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Lowercased substrings scored to find a good default vision model. */
const VISION_SCORE_TABLE: ReadonlyArray<[string, number]> = [
  ["vision", 100],
  ["gpt-4o", 90],
  ["gpt-4.1", 88],
  ["gpt-4-turbo", 80],
  ["gpt-5", 82],
  ["o3", 78],
  ["o4", 78],
  ["claude-4", 85],
  ["claude-3-7", 84],
  ["claude-3-5", 84],
  ["claude-3", 80],
  ["gemini-3", 86],
  ["gemini-2", 84],
  ["gemini-1.5", 78],
  ["gemini", 72],
  ["qwen2.5-vl", 84],
  ["qwen2-vl", 82],
  ["qwen3", 70],
  ["qwen-vl", 80],
  ["internvl", 78],
  ["glm-4v", 78],
  ["glm-4.5v", 82],
  ["pixtral", 80],
  ["llava", 76],
  ["phi-3-vision", 74],
  ["phi-4-multimodal", 76],
  ["llama-3.2", 74],
  ["minicpm-v", 76],
  ["moondream", 72],
  ["idefics", 74],
  ["cogvlm", 72],
  ["doubao", 70],
  ["hunyuan", 68],
  ["step-1v", 70],
  ["kimi", 60],
  ["moonshot", 60],
  ["deepseek-vl", 70],
  ["deepseek", 40],
  ["yi-vision", 70],
  ["-vl", 70],
  ["-vlm", 72],
  ["multimodal", 70],
];

function visionScore(model: AnyModel): number {
  const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
  let score = 0;
  for (const [needle, weight] of VISION_SCORE_TABLE) {
    if (haystack.includes(needle)) score += weight;
  }
  return score;
}

/**
 * Resolve `provider/modelId`, a bare model id, or a fuzzy id substring
 * (case-insensitive) against the registry. Exact ids win over substring
 * matches so users are never surprised by partial matches.
 */
export function findModelById(registry: ModelRegistry, pattern: string): AnyModel | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.lastIndexOf("/");
  const available = registry.getAvailable();
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const id = trimmed.slice(slash + 1);
    const found =
      registry.find(provider, id) ??
      available.find((m) => m.id === id && (m.provider === provider || m.provider.toLowerCase() === provider.toLowerCase()));
    if (found) return found;
  }
  const lower = trimmed.toLowerCase();
  return (
    available.find((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed || m.name === trimmed) ??
    available.find((m) => m.id.toLowerCase() === lower) ??
    available.find((m) => m.id.toLowerCase().includes(lower))
  );
}

export interface VisionModelSelection {
  model: AnyModel;
  /** Human-readable source of the selection. */
  source: "explicit" | "configured" | "active" | "catalogue";
}

/**
 * Vision model resolution priority:
 *   1. `explicitPattern` — the tool's `model` parameter
 *   2. `configuredDefault` — extension config / PI_INSPECT_IMAGE_MODEL env
 *   3. `activeModel` — the current session model, when it accepts images
 *   4. scored catalogue default
 */
export function resolveVisionModel(
  registry: ModelRegistry,
  activeModel: AnyModel | undefined,
  explicitPattern?: string,
  configuredDefault?: string,
): VisionModelSelection | null {
  const byId = (pattern: string): AnyModel | undefined => {
    const found = findModelById(registry, pattern);
    return found && found.input.includes("image") ? found : undefined;
  };

  const tryResolve = (pattern: string | undefined, source: VisionModelSelection["source"]): VisionModelSelection | null => {
    if (!pattern) return null;
    const found = byId(pattern);
    if (found) return { model: found, source };
    return null;
  };

  const explicit = tryResolve(explicitPattern, "explicit");
  if (explicit) return explicit;
  if (explicitPattern && !configuredDefault) {
    // User explicitly asked for a model we cannot resolve: surface the error
    // rather than silently falling back.
    throw new Error(
      `inspect_image: cannot resolve vision-capable model "${explicitPattern}". ` +
        `Provide a provider/id or model id from the catalogue with image input, e.g. "New_new_private/Auto-Multi", "qwen3-vl", or "MiniMax-M3".`,
    );
  }

  const configured = tryResolve(configuredDefault, "configured");
  if (configured) return configured;
  if (configuredDefault) {
    throw new Error(
      `inspect_image: the configured default vision model "${configuredDefault}" could not be resolved with image input. ` +
        `Check PI_INSPECT_IMAGE_MODEL / inspect-image.json, or unset it to use automatic routing.`,
    );
  }

  if (activeModel && activeModel.input.includes("image")) {
    return { model: activeModel, source: "active" };
  }

  const candidates = registry
    .getAvailable()
    .filter((m) => m.input.includes("image"))
    .sort((a, b) => visionScore(b) - visionScore(a) || a.id.localeCompare(b.id));

  if (candidates.length === 0) return null;
  return { model: candidates[0]!, source: "catalogue" };
}

export function isVisionCapable(model: AnyModel | undefined): boolean {
  return Boolean(model?.input.includes("image"));
}

export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

/** Resolve credentials for a model. Throws with an actionable message when unavailable. */
export async function resolveModelAuth(registry: ModelRegistry, model: AnyModel): Promise<ResolvedAuth> {
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(
      `inspect_image: no API key available for ${model.provider}/${model.id}. ` +
        `Configure credentials for this provider or choose another vision-capable model. (${auth.error})`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
  }
  return { apiKey: auth.apiKey, headers };
}