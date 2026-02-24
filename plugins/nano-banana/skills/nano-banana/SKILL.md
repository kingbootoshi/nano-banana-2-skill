---
name: nano-banana
description: Generates AI images using the nano-banana CLI (Gemini 3 Pro). Handles reference images for style transfer, green screen workflow for transparent assets, and exact dimension control. Use when asked to "generate an image", "create a sprite", "make an asset", "generate artwork", or any image generation task for UI mockups, game assets, videos, or marketing materials.
---

# nano-banana

AI image generation CLI powered by Gemini 3 Pro Image Preview.

## Quick Reference

- Command: `nano-banana "prompt" [options]`
- Default output: 2K resolution, current directory

## Core Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output` | `nano-gen-{timestamp}` | Output filename (no extension) |
| `-s, --size` | `2K` | Image size: `1K` or `2K` |
| `-d, --dir` | current directory | Output directory |
| `-r, --ref` | - | Reference image (can use multiple times) |
| `-t, --transparent` | - | Remove chroma key background |
| `--chroma` | `#00FF00` | Color to remove with -t |
| `--fuzz` | `10` | Color tolerance % |
| `--api-key` | - | Gemini API key (overrides env/file) |

## Key Workflows

### Basic Generation

```bash
nano-banana "minimal dashboard UI with dark theme"
```

### Reference Images (Style Transfer / Editing)

```bash
# Edit existing image
nano-banana "change the background to pure white" -r dark-ui.png -o light-ui

# Style transfer - multiple references
nano-banana "combine these two styles" -r style1.png -r style2.png -o combined
```

### Transparent Assets (Green Screen)

```bash
nano-banana "robot mascot on solid neon green background #00FF00" -t -o mascot
```

Prompt tips for clean transparency:
- "on solid neon green background"
- "green screen background #00FF00"
- "uniform green, sharp edges, no shadows on background"

The chroma key pipeline is broadcast-grade:
1. Auto-detects actual background color via K-means clustering
2. Builds soft matte using color difference (handles edge mixing)
3. Refines matte with morphological operations
4. Unmixes/unpremultiplies edge colors to remove green halos
5. Despills remaining green tint from edges
6. Applies refined alpha for clean transparency
7. Falls back to simple fuzz method if advanced pipeline fails

### Exact Dimensions

To get a specific output dimension:
1. First `-r` flag: your reference/style image
2. Last `-r` flag: blank image in target dimensions
3. Include dimensions in prompt

```bash
# Generate blank canvas first, then use as dimension template
nano-banana "pixel art character in style of first image, 256x256" -r style.png -r blank-256x256.png -o sprite
```

## Reference Order Matters

- First reference: primary style/content source
- Additional references: secondary influences
- Last reference: controls output dimensions (if using blank image trick)

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

# Product shots
nano-banana "premium software product hero image, floating UI elements"

# Backgrounds
nano-banana "subtle gradient, minimal, luxury feel, white to light gray"

# Dark mode UI
nano-banana "Premium SaaS chat interface, dark mode, minimal, Linear-style aesthetic"

# Game assets with transparency
nano-banana "pixel art treasure chest on solid neon green background #00FF00" -t -o chest
```

## API Key Setup

The CLI resolves the Gemini API key in this order:
1. `--api-key` flag
2. `GEMINI_API_KEY` environment variable
3. `.env` file in current directory
4. `.env` file next to the CLI script
5. `~/.nano-banana/.env`

Get a key at: https://aistudio.google.com/apikey
