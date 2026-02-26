---
name: nano-banana
description: Generates AI images using the nano-banana CLI (Gemini 3.1 Flash default, Pro available). Handles multi-resolution (512-4K), aspect ratios, reference images for style transfer, green screen workflow for transparent assets, cost tracking, and exact dimension control. Use when asked to "generate an image", "create a sprite", "make an asset", "generate artwork", or any image generation task for UI mockups, game assets, videos, or marketing materials.
---

# nano-banana

AI image generation CLI. Default model: Gemini 3.1 Flash Image Preview (Nano Banana 2).

## /init - First-Time Setup

When the user says "init", "setup nano-banana", or "install nano-banana", run these commands to get the CLI tool on their machine. No sudo required.

**Prerequisites:** Bun must be installed. If not: `curl -fsSL https://bun.sh/install | bash`

```bash
# 1. Clone the repo
git clone https://github.com/kingbootoshi/nano-banana-2-skill.git ~/tools/nano-banana-2

# 2. Install dependencies
cd ~/tools/nano-banana-2 && bun install

# 3. Link globally (creates `nano-banana` command via Bun - no sudo)
cd ~/tools/nano-banana-2 && bun link

# 4. Set up API key
mkdir -p ~/.nano-banana
echo "GEMINI_API_KEY=<ask user for their key>" > ~/.nano-banana/.env
```

After init, the user can type `nano-banana "prompt"` from anywhere.

If `bun link` fails or the command is not found after linking, fall back to:
```bash
mkdir -p ~/.local/bin
ln -sf ~/tools/nano-banana-2/src/cli.ts ~/.local/bin/nano-banana
# Then ensure ~/.local/bin is on PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Get a Gemini API key at: https://aistudio.google.com/apikey

## Quick Reference

- Command: `nano-banana "prompt" [options]`
- Default: 1K resolution, Flash model, current directory

## Core Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output` | `nano-gen-{timestamp}` | Output filename (no extension) |
| `-s, --size` | `1K` | Image size: `512`, `1K`, `2K`, or `4K` |
| `-a, --aspect` | model default | Aspect ratio: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, etc. |
| `-m, --model` | `flash` | Model: `flash`/`nb2`, `pro`/`nb-pro`, or any model ID |
| `-d, --dir` | current directory | Output directory |
| `-r, --ref` | - | Reference image (can use multiple times) |
| `-t, --transparent` | - | Remove background (AI-powered, any color) |
| `--api-key` | - | Gemini API key (overrides env/file) |
| `--costs` | - | Show cost summary |

## Models

| Alias | Model | Use When |
|-------|-------|----------|
| `flash`, `nb2` | Gemini 3.1 Flash | Default. Fast, cheap (~$0.067/1K image) |
| `pro`, `nb-pro` | Gemini 3 Pro | Highest quality needed (~$0.134/1K image) |

## Sizes

| Size | Cost (Flash) | Cost (Pro) |
|------|-------------|------------|
| `512` | ~$0.045 | Flash only |
| `1K` | ~$0.067 | ~$0.134 |
| `2K` | ~$0.101 | ~$0.201 |
| `4K` | ~$0.151 | ~$0.302 |

## Aspect Ratios

Supported: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9`

Use `-a` flag: `nano-banana "cinematic scene" -a 16:9`

## Key Workflows

### Basic Generation

```bash
nano-banana "minimal dashboard UI with dark theme"
nano-banana "cinematic landscape" -s 2K -a 16:9
nano-banana "quick concept sketch" -s 512
```

### Model Selection

```bash
# Default (Flash - fast, cheap)
nano-banana "your prompt"

# Pro (highest quality)
nano-banana "detailed portrait" --model pro -s 2K
```

### Reference Images (Style Transfer / Editing)

```bash
# Edit existing image
nano-banana "change the background to pure white" -r dark-ui.png -o light-ui

# Style transfer - multiple references
nano-banana "combine these two styles" -r style1.png -r style2.png -o combined
```

### Transparent Assets

```bash
nano-banana "robot mascot character" -t -o mascot
nano-banana "pixel art treasure chest" -t -o chest
```

No green screen prompting needed. The `-t` flag uses AI-powered background removal (withoutbg) + ImageMagick edge cleanup for pixel-perfect transparency. Works with any background color.

Requires: `pip install withoutbg` (first run downloads ~318MB of AI models, then works offline).

### Exact Dimensions

To get a specific output dimension:
1. First `-r` flag: your reference/style image
2. Last `-r` flag: blank image in target dimensions
3. Include dimensions in prompt

```bash
nano-banana "pixel art character in style of first image, 256x256" -r style.png -r blank-256x256.png -o sprite
```

## Reference Order Matters

- First reference: primary style/content source
- Additional references: secondary influences
- Last reference: controls output dimensions (if using blank image trick)

## Cost Tracking

Every generation is logged to `~/.nano-banana/costs.json`. View summary:

```bash
nano-banana --costs
```

## Use Cases

- **Landing page assets** - product mockups, UI previews
- **Image editing** - transform existing images with prompts
- **Style transfer** - combine multiple reference images
- **Marketing materials** - hero images, feature illustrations
- **UI iterations** - quickly generate variations of designs
- **Transparent assets** - icons, logos, mascots with no background
- **Game assets** - sprites, backgrounds, characters
- **Video production** - visual elements for video compositions

## Prompt Examples

```bash
# UI mockups
nano-banana "clean SaaS dashboard with analytics charts, white background"

# Widescreen cinematic
nano-banana "cyberpunk cityscape at sunset" -a 16:9 -s 2K

# Product shots with Pro quality
nano-banana "premium software product hero image" --model pro

# Quick low-res concept
nano-banana "rough sketch of a robot" -s 512

# Dark mode UI
nano-banana "Premium SaaS chat interface, dark mode, minimal, Linear-style aesthetic"

# Game assets with transparency
nano-banana "pixel art treasure chest on solid neon green background #00FF00" -t -o chest

# Portrait aspect ratio
nano-banana "mobile app onboarding screen" -a 9:16
```

## API Key Setup

The CLI resolves the Gemini API key in this order:
1. `--api-key` flag
2. `GEMINI_API_KEY` environment variable
3. `.env` file in current directory
4. `.env` file next to the CLI script
5. `~/.nano-banana/.env`

Get a key at: https://aistudio.google.com/apikey
