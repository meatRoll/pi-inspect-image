/**
 * Image input loading: path resolution, content-based MIME sniffing, size caps,
 * optional resize (via pi's built-in resizeImage), and attachment references.
 * Adapted from oh-my-pi's packages/coding-agent/src/utils/image-loading.ts.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Upload input cap: 20 MiB. */
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export class ImageInputTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
    this.name = "ImageInputTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < Math.min(end, bytes.length); i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Detect PNG/JPEG/GIF/WebP from file content (not filename). */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header6 = ascii(bytes, 0, 6);
  if (header6 === "GIF87a" || header6 === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

export interface LoadedImageInput {
  /** Filesystem path for file inputs, or the attachment label/URI for attachments. */
  resolvedPath: string;
  mimeType: string;
  /** Base64-encoded image bytes actually sent to the model. */
  data: string;
  bytes: number;
  wasResized: boolean;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
}

/** MIME extension sniffing for `data:` URLs. */
function mimeFromDataUrl(dataUrl: string): string | undefined {
  const match = /^data:([^;,]+);base64,/.exec(dataUrl);
  if (!match) return undefined;
  const mime = match[1]!.toLowerCase();
  return SUPPORTED_IMAGE_MIME_TYPES.has(mime) ? mime : undefined;
}

export interface LoadImageOptions {
  /** User-provided path: file path, `Image #N`, `attachment://N`, `image://N`, or `data:` URL. */
  path: string;
  cwd: string;
  /** Current-turn image attachments (for `Image #N` references). */
  attachments?: readonly ImageContent[];
  autoResize?: boolean;
  maxBytes?: number;
}

const IMAGE_ATTACHMENT_REFERENCE_REGEX =
  /^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

export type LoadedImageSource =
  | { kind: "file"; absPath: string }
  | { kind: "attachment"; index: number };

/** Parse `Image #N`, `[Image #N, ...]`, `attachment://N`, `image://N` (1-based). */
export function parseImageReference(path: string): LoadedImageSource | null {
  const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(path);
  if (!match) return null;
  const rawIndex = match[1] ?? match[2];
  if (!rawIndex) return null;
  return { kind: "attachment", index: Number(rawIndex) };
}

async function resolveReadablePath(path: string, cwd: string): Promise<string> {
  let candidate = isAbsolute(path) ? path : resolve(cwd, path);
  // Mirror built-in read tool behavior: strip a leading @ before resolving.
  if (candidate.startsWith("@")) candidate = candidate.slice(1);
  try {
    const s = await stat(candidate);
    if (s.isFile()) return candidate;
  } catch {
    // fall through to unescape variants
  }
  // macOS path quirks: unescape shell-escaped spaces.
  const unescaped = candidate.replace(/\\ /g, " ");
  if (unescaped !== candidate) {
    try {
      const s = await stat(unescaped);
      if (s.isFile()) return unescaped;
    } catch {
      // keep original
    }
  }
  return candidate;
}

async function resizeIfNeeded(
  data: string,
  mimeType: string,
  autoResize: boolean,
  excludeWebP: boolean,
): Promise<{ data: string; mimeType: string; bytes: number; wasResized: boolean; originalWidth?: number; originalHeight?: number; width?: number; height?: number }> {
  const inputBytes = Buffer.from(data, "base64");
  if (autoResize || (excludeWebP && mimeType === "image/webp")) {
    try {
      const resized = await resizeImage(inputBytes, mimeType, {
        maxWidth: 1568,
        maxHeight: 1568,
        maxBytes: 500 * 1024,
        jpegQuality: 80,
      });
      if (resized) {
        return {
          data: resized.data,
          mimeType: resized.mimeType,
          bytes: Math.floor((resized.data.length * 3) / 4),
          wasResized: resized.wasResized,
          originalWidth: resized.originalWidth,
          originalHeight: resized.originalHeight,
          width: resized.width,
          height: resized.height,
        };
      }
    } catch {
      // keep original image when resize fails
    }
  }
  return { data, mimeType, bytes: inputBytes.byteLength, wasResized: false };
}

/** Load a file: sniff MIME, enforce size cap, optionally resize. Returns null for unsupported formats. */
export async function loadImageFile(options: LoadImageOptions & { absPath: string }): Promise<LoadedImageInput | null> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
  const buffer = await readFile(options.absPath);

  const mimeType = sniffMimeType(buffer);
  if (!mimeType) return null;
  if (buffer.byteLength > maxBytes) throw new ImageInputTooLargeError(buffer.byteLength, maxBytes);

  const inputData = buffer.toString("base64");
  const excludeWebP = false; // pi handles WebP decoding; no STB exclusion needed here
  const resized = await resizeIfNeeded(inputData, mimeType, options.autoResize ?? true, excludeWebP);

  return {
    resolvedPath: options.absPath,
    mimeType: resized.mimeType,
    data: resized.data,
    bytes: resized.bytes,
    wasResized: resized.wasResized,
    originalWidth: resized.originalWidth,
    originalHeight: resized.originalHeight,
    width: resized.width,
    height: resized.height,
  };
}

/** Load a current-turn attachment by 1-based index. */
export function loadImageAttachmentFromList(
  attachments: readonly ImageContent[],
  index: number,
  path: string,
): ImageContent {
  const attachment = attachments[index - 1];
  if (!attachment) {
    if (attachments.length === 0) {
      throw new Error(
        `No image attachments are available in this turn. path="${path}" must be a readable file path or attachment URI.`,
      );
    }
    const available = attachments
      .map((_, i) => `Image #${i + 1}`)
      .join(", ");
    throw new Error(
      `Could not resolve image attachment '${path}'. Available image attachments: ${available}. Pass an attachment URI or a readable filesystem path.`,
    );
  }
  return attachment;
}

export interface LoadResult {
  input: LoadedImageInput | null;
  error?: Error;
}

/**
 * High-level loader used by the tool:
 * - `Image #N` / `attachment://N` / `image://N` → attachment from the current turn
 * - `data:image/...;base64,...` → inline image
 * - otherwise → filesystem file (relative to cwd)
 */
export async function loadImageInput(options: LoadImageOptions): Promise<LoadResult> {
  const ref = parseImageReference(options.path);
  if (ref && ref.kind === "attachment") {
    const attachments = options.attachments ?? [];
    const attachment = loadImageAttachmentFromList(attachments, ref.index, options.path);
    const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
    const rawBytes = Buffer.byteLength(attachment.data, "base64");
    if (rawBytes > maxBytes) throw new ImageInputTooLargeError(rawBytes, maxBytes);
    const resized = await resizeIfNeeded(
      attachment.data,
      attachment.mimeType,
      options.autoResize ?? true,
      false,
    );
    return {
      input: {
        resolvedPath: `Image #${ref.index}`,
        mimeType: resized.mimeType,
        data: resized.data,
        bytes: resized.bytes,
        wasResized: resized.wasResized,
        originalWidth: resized.originalWidth,
        originalHeight: resized.originalHeight,
        width: resized.width,
        height: resized.height,
      },
    };
  }

  if (options.path.startsWith("data:")) {
    const mimeType = mimeFromDataUrl(options.path);
    if (!mimeType) return { input: null };
    const data = options.path.slice(options.path.indexOf(";base64,") + ";base64,".length);
    const rawBytes = Buffer.byteLength(data, "base64");
    if (rawBytes > (options.maxBytes ?? MAX_IMAGE_INPUT_BYTES)) {
      throw new ImageInputTooLargeError(rawBytes, options.maxBytes ?? MAX_IMAGE_INPUT_BYTES);
    }
    const resized = await resizeIfNeeded(data, mimeType, options.autoResize ?? true, false);
    return {
      input: {
        resolvedPath: options.path.slice(0, 64),
        mimeType: resized.mimeType,
        data: resized.data,
        bytes: resized.bytes,
        wasResized: resized.wasResized,
        originalWidth: resized.originalWidth,
        originalHeight: resized.originalHeight,
        width: resized.width,
        height: resized.height,
      },
    };
  }

  const absPath = await resolveReadablePath(options.path, options.cwd);
  const input = await loadImageFile({ ...options, absPath });
  return { input };
}

/** Collect image blocks from the most recent user messages in the session branch. */
export function collectTurnImageAttachments(entries: readonly { type: string; message?: { role?: string; content?: unknown } }[]): ImageContent[] {
  const images: ImageContent[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content !== "string" && Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "image") {
          const img = part as ImageContent;
          if (typeof img.data === "string" && typeof img.mimeType === "string") {
            images.push(img);
          }
        }
      }
    }
  }
  return images;
}

