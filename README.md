# Nano Banana

AI image generation CLI powered by Gemini 3 Pro Image Preview. Generates high-quality 2K images from text prompts with reference image support, broadcast-grade green screen transparency, and style transfer.

Also ships as a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill for AI-assisted image generation workflows.

## Install

**Requirements:** [Bun](https://bun.sh), [ImageMagick](https://imagemagick.org) (for transparent mode)

```bash
# Clone the repo
git clone https://github.com/kingbootoshi/nano-banana.git
cd nano-banana

# Install dependencies
bun install

# Set up your API key
cp .env.example .env
# Edit .env and add your Gemini API key from https://aistudio.google.com/apikey

# Link globally (optional)
sudo ln -sf "$(pwd)/src/cli.ts" /usr/local/bin/nano-banana
```

### As a Claude Code Plugin

```
/plugin marketplace add kingbootoshi/nano-banana
/plugin install nano-banana
```

Then use it by saying "generate an image of..." or invoke directly with `/nano-banana`.

## Usage

```bash
# Basic - generates to current directory
nano-banana "minimal dashboard UI with dark theme"

# Custom output name
nano-banana "luxury product mockup" -o product

# Specify size (1K or 2K)
nano-banana "abstract gradient background" -s 1K

# Custom output directory
nano-banana "UI screenshot" -o dashboard -d ~/Pictures
```

### Reference Images

Edit, transform, or combine existing images:

```bash
# Edit an existing image
nano-banana "change the background to pure white" -r dark-ui.png -o light-ui

# Style transfer - multiple references
nano-banana "combine these two UI styles into one" -r style1.png -r style2.png -o combined

# Color correction
nano-banana "make this image more vibrant and increase contrast" -r photo.jpg
```

### Transparent Assets (Green Screen)

Generate assets with transparent backgrounds using a broadcast-grade chroma key pipeline:

```bash
# Basic transparent asset
nano-banana "robot mascot character on solid neon green background #00FF00" -t -o mascot

# Logo with transparency
nano-banana "minimalist tech logo on bright green screen background" -t -o logo
```

**Prompt tips for clean edges:**
- "on solid neon green background"
- "green screen background #00FF00"
- "uniform green, sharp edges, no shadows on background"

### Exact Dimensions

Control output dimensions by using a blank image as the last reference:

```bash
# First -r: your style reference
# Last -r: blank image in target dimensions
nano-banana "pixel art character, 256x256" -r style.png -r blank-256x256.png -o sprite
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output` | `nano-gen-{timestamp}` | Output filename (no extension) |
| `-s, --size` | `2K` | Image size: `1K` or `2K` |
| `-d, --dir` | current directory | Output directory |
| `-r, --ref` | - | Reference image (can use multiple times) |
| `-t, --transparent` | - | Remove chroma key background |
| `--chroma` | `#00FF00` | Color to remove when using -t |
| `--fuzz` | `10` | Color tolerance % (higher = more lenient) |
| `--api-key` | - | Gemini API key (overrides env/file) |
| `-h, --help` | - | Show help |

## API Key Configuration

The CLI resolves the Gemini API key in priority order:

1. `--api-key` flag on the command line
2. `GEMINI_API_KEY` environment variable
3. `.env` file in the current working directory
4. `.env` file in the repo root (next to `src/`)
5. `~/.nano-banana/.env`

Get a free key at [Google AI Studio](https://aistudio.google.com/apikey).

```bash
# Option 1: Environment variable
export GEMINI_API_KEY=your_key_here

# Option 2: .env file in current directory
echo "GEMINI_API_KEY=your_key_here" > .env

# Option 3: Global config
mkdir -p ~/.nano-banana
echo "GEMINI_API_KEY=your_key_here" > ~/.nano-banana/.env

# Option 4: Pass directly
nano-banana "your prompt" --api-key your_key_here
```

## How the Green Screen Pipeline Works

AI image generators cannot output true transparency - they render checkered patterns onto the image. Instead, we use a professional green screen workflow:

1. **Prompt for green background** - ask for "solid neon green background #00FF00"
2. **Auto-detect actual color** - K-means clustering on corner pixels finds the real shade (AI rarely generates exact #00FF00)
3. **Build soft matte** - color difference compositing creates continuous alpha, handling edge mixing
4. **Refine matte** - morphological close/open operations fill holes and remove specks
5. **Unmix edges** - formula `v==0 ? 0 : u/v - KEY/v + KEY` recovers original edge colors buried under green
6. **Despill** - green channel limiter `g > (r+b)/2 ? (r+b)/2 : g` removes remaining green tint
7. **Apply alpha** - composite refined alpha onto despilled image

Falls back to simple fuzz + erosion if the advanced pipeline encounters issues.

## Use Cases

- **Landing page assets** - product mockups, UI previews
- **Image editing** - transform existing images with text prompts
- **Style transfer** - combine multiple reference images
- **Marketing materials** - hero images, feature illustrations
- **UI iterations** - quickly generate design variations
- **Transparent assets** - icons, logos, mascots with no background
- **Game assets** - sprites, tilesets, characters
- **Video production** - visual elements for Remotion/video compositions

## Claude Code Skill

When installed as a Claude Code plugin, the skill triggers on phrases like:
- "generate an image"
- "create a sprite"
- "make an asset"
- "generate artwork"

Claude will construct the appropriate `nano-banana` command based on your request, handling reference images, transparency, and output configuration automatically.

## License

MIT
