# pi-inspect-image

An [pi](https://github.com/earendil-works/pi) extension that adds the `inspect_image`
tool: analyze **local image files**, **pasted image attachments**, or **data URLs**
through a vision-capable model and return its text analysis.

Built for pi's model catalog: even when your main chat model does not accept image
input, `inspect_image` routes the image to the best available vision-capable model
(the active model if it supports images, otherwise a scored default from the
registered catalogue). No model switching required — the tool does the vision work
for you.

> This is a re-implementation of the `inspect_image` tool originally developed in
> [oh-my-pi](https://github.com/earendil-works/oh-my-pi) (a pi fork), built on pi's
> public extension API so it works on upstream pi.

## Features

- **File paths** — resolved relative to the session cwd:
  `path: "screenshots/error.png"`
- **Pasted images** — reference images attached in the current turn:
  `path: "Image #1"`, `path: "[Image #2, caption]"`, `path: "attachment://1"`, or `path: "image://1"` (1-based)
- **Data URLs** — `path: "data:image/png;base64,...."`
- **Content-based format detection** — PNG / JPEG / GIF / WebP are sniffed from
  file bytes, not extensions. Other files are rejected.
- **Size cap** — inputs over 20 MiB are rejected before upload.
- **Auto-resize** — oversized images are downscaled/re-encoded (`1568×1568`,
  ~500 KiB target, JPEG q80) before being sent to the model.
- **Model routing** — uses the active model when it accepts images, else the
  highest-scored vision model from your registered catalogue; override with the
  `model` parameter (`"anthropic/claude-sonnet-4-5"` or a bare model id).
- **Cancellation & timeout** — respects the agent's abort signal and enforces a
  5-minute vision request timeout.

## Install

### As a pi package

```bash
pi install git:github.com/<you>/pi-inspect-image
```

or locally:

```bash
pi install /path/to/pi-inspect-image
```

Installed extensions are auto-discovered. Restart pi (or `/reload`) to pick up the
tool. `pi -e git:github.com/<you>/pi-inspect-image` tries it for one run without installing.

### As a plain extension

Symlink or copy the repo into an auto-discovered extension location:

```
~/.pi/agent/extensions/pi-inspect-image/   # global
.pi/extensions/pi-inspect-image/           # project-local
```

then run `/reload` in pi.

## Usage

The tool's `question` parameter should be specific: state what to inspect, any
constraints ("quote visible text verbatim", "only report confirmed findings"),
and the desired output format (bullets / table / JSON / short answer).

```bash
pi /resume
```

```text
> Use inspect_image to OCR screenshots/error.png: extract all visible text verbatim as a bullet list.
> What's wrong with the Save button in screenshots/settings.png? Report observations and likely cause.
> Inspect Image #1 and describe what's in the photo.
```

### Requirements

- A **vision-capable model** must be resolvable from your pi model catalogue:
  either the active model supports `image` input, or one of these is present in
  your providers:
  `gpt-4o` / `gpt-4.1` / `gpt-5` / `o3` / `o4` / `claude-3-5` / `claude-3-7` /
  `claude-4` / `gemini-*` / `qwen-vl` / `qwen2.5-vl` / `internvl` / `glm-4v` /
  `pixtral` / `llava` / `phi-3-vision` / `phi-4-multimodal` / `moondream`, or any
  model advertising image input.
- Credentials for that provider must be configured (`/login` or env keys). Without
  them the tool fails with an actionable error.

### Configuration

The tool needs no settings. Optional per-call parameters:

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | — | File path, `Image #N`, `attachment://N` / `image://N`, or `data:` URL |
| `question` | string | — | What to inspect and how to report |
| `model` | string | auto | `provider/modelId` or bare model id to force a vision model |
| `autoResize` | boolean | `true` | Disable to upload the original bytes verbatim |

## How it works

1. Resolves the vision model (active model → scored catalogue default → explicit override).
2. Resolves credentials via `ModelRegistry.getApiKeyAndHeaders`.
3. Loads the image (attachment reference, data URL, or file with MIME sniffing and
   the 20 MiB cap) and optionally resizes it with pi's built-in `resizeImage`.
4. Sends one user message (`image` + `text` content blocks) via
   `ModelRegistry.complete` with a small image-analysis system prompt.
5. Returns the concatenated assistant text; errors surface as thrown `ToolError`s.

Supported input formats (by content): `image/png`, `image/jpeg`, `image/gif`, `image/webp`.

## Development

```bash
npm install          # installs dev deps for typecheck
npm run typecheck    # tsc --noEmit
```

Load the local repo in pi for testing:

```bash
pi -e /path/to/pi-inspect-image
```

## License

MIT