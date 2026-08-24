/**
 * Extension configuration for pi-inspect-image.
 *
 * Priority (highest wins):
 *   1. `PI_INSPECT_IMAGE_MODEL` environment variable
 *   2. `defaultModel` in `~/.pi/agent/inspect-image.json`
 *
 * The JSON file is optional; everything keeps working without it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface InspectImageConfig {
  /** Default vision model used when the tool's `model` parameter is absent. */
  defaultModel?: string;
  /** Offset the auto-resize defaults for this environment (optional). */
  maxBytes?: number;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "inspect-image.json");

let cachedConfig: InspectImageConfig | undefined;
let cachedPath: string | undefined;

export async function loadInspectImageConfig(): Promise<InspectImageConfig> {
  if (cachedConfig && cachedPath) return cachedConfig;
  return refreshInspectImageConfig();
}

/** Re-read config; used by tests and after config file edits in long-running sessions. */
export async function refreshInspectImageConfig(): Promise<InspectImageConfig> {
  let fileConfig: InspectImageConfig = {};
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as InspectImageConfig;
    if (parsed && typeof parsed === "object") fileConfig = parsed;
  } catch {
    // missing/unreadable file → defaults
  }
  const envDefault = process.env.PI_INSPECT_IMAGE_MODEL?.trim();
  const config: InspectImageConfig = {
    ...fileConfig,
    ...(envDefault ? { defaultModel: envDefault } : {}),
  };
  cachedConfig = config;
  cachedPath = CONFIG_PATH;
  return config;
}

/** Human-readable description of where the default vision model came from. */
export function describeConfigSource(): { defaultModel?: string; file: string } {
  return { defaultModel: cachedConfig?.defaultModel, file: CONFIG_PATH };
}

/** The config file path, for docs/errors. */
export function configFilePath(): string {
  return CONFIG_PATH;
}

/**
 * Persist the default vision model (used by the `/vision` command).
 * `null` removes the setting entirely (back to automatic routing).
 */
export async function setDefaultVisionModel(model: string | null): Promise<void> {
  let next: InspectImageConfig = {};
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as InspectImageConfig;
    if (parsed && typeof parsed === "object") next = parsed;
  } catch {
    // file missing or unparseable → start fresh
  }
  if (model === null) {
    delete next.defaultModel;
  } else {
    next.defaultModel = model;
  }
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await refreshInspectImageConfig();
}