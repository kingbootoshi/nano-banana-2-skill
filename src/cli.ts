#!/usr/bin/env bun
/**
 * Nano Banana - AI Image Generation CLI
 * Powered by Gemini 3 Pro Image Preview
 *
 * Usage:
 *   nano-banana "your prompt here"
 *   nano-banana "your prompt" --output myimage
 *   nano-banana "your prompt" --ref image.png        # Use reference image
 *   nano-banana "your prompt" -r img1.png -r img2.png # Multiple references
 */

import { GoogleGenAI } from "@google/genai";
import { writeFile, mkdir, readFile } from "fs/promises";
import { join, extname, basename, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Environment / API key resolution
// Priority: --api-key flag > GEMINI_API_KEY env var > .env in cwd > .env next
// to this script > ~/.nano-banana/.env
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").replace(/^["']|["']$/g, "");
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

// Try multiple .env locations (first match wins per-key due to the guard above)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnvFile(join(process.cwd(), ".env"));
loadEnvFile(join(__dirname, "..", ".env"));         // repo root .env
loadEnvFile(join(homedir(), ".nano-banana", ".env"));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Options {
  prompt: string;
  output: string;
  size: "1K" | "2K";
  outputDir: string;
  referenceImages: string[];
  transparent: boolean;
  chromaColor: string;
  fuzz: number;
  apiKey: string | undefined;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "image/png";
}

async function loadImageAsBase64(
  filePath: string
): Promise<{ data: string; mimeType: string }> {
  const absolutePath = filePath.startsWith("/")
    ? filePath
    : join(process.cwd(), filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const buffer = await readFile(absolutePath);
  return {
    data: buffer.toString("base64"),
    mimeType: getMimeType(filePath),
  };
}

function runMagick(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("magick", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`ImageMagick failed: ${stderr}`));
    });
    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to run ImageMagick: ${err.message}. Is it installed? (brew install imagemagick)`
        )
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Chroma key removal - broadcast-grade pipeline
// ---------------------------------------------------------------------------

async function removeChromaKey(
  inputPath: string,
  chromaColor: string,
  fuzz: number
): Promise<string> {
  const dir = inputPath.substring(0, inputPath.lastIndexOf("/"));
  const name = basename(inputPath, extname(inputPath));
  const outputPath = join(dir, `${name}.png`);

  const tempAlpha = join(dir, `${name}_alpha.png`);
  const tempAlphaRef = join(dir, `${name}_alpha_ref.png`);
  const tempUnblended = join(dir, `${name}_unblended.png`);
  const tempDespilled = join(dir, `${name}_despilled.png`);

  const cleanup = async () => {
    const { unlink } = await import("fs/promises");
    await Promise.all([
      unlink(tempAlpha).catch(() => {}),
      unlink(tempAlphaRef).catch(() => {}),
      unlink(tempUnblended).catch(() => {}),
      unlink(tempDespilled).catch(() => {}),
    ]);
  };

  try {
    // Step 1: Auto-detect the actual background color from corner patch.
    // AI-generated greens are rarely exactly #00FF00.
    let keyColor = chromaColor;
    try {
      const detected = await runMagick([
        inputPath,
        "-gravity",
        "NorthWest",
        "-crop",
        "10%x10%+0+0",
        "+repage",
        "-kmeans",
        "3",
        "-format",
        "%[dominant-color]",
        "info:",
      ]);
      if (detected && detected.startsWith("#")) {
        keyColor = detected;
        console.log(`  \x1b[90mDetected background: ${keyColor}\x1b[0m`);
      }
    } catch {
      // Fallback: sample top-left pixel
      const pixel = await runMagick([
        inputPath,
        "-format",
        "%[hex:p{0,0}]",
        "info:",
      ]);
      if (pixel) {
        keyColor = `#${pixel}`;
        console.log(`  \x1b[90mSampled background: ${keyColor}\x1b[0m`);
      }
    }

    // Step 2: Build soft matte using color difference
    await runMagick([
      inputPath,
      "-alpha",
      "off",
      "(",
      "+clone",
      "-fill",
      keyColor,
      "-colorize",
      "100%",
      ")",
      "-compose",
      "difference",
      "-composite",
      "-separate",
      "-evaluate-sequence",
      "max",
      "-auto-level",
      "-blur",
      "0x1",
      "-level",
      "5%,95%",
      tempAlpha,
    ]);

    // Step 3: Refine matte with morphology (close holes, open specks, feather)
    await runMagick([
      tempAlpha,
      "-morphology",
      "Close",
      "Diamond:1",
      "-morphology",
      "Open",
      "Diamond:1",
      "-blur",
      "0x0.7",
      tempAlphaRef,
    ]);

    // Step 4: Unmix/unpremultiply - removes green halo from edges
    // Formula: v==0 ? 0 : u/v - KEY/v + KEY
    await runMagick([
      inputPath,
      tempAlphaRef,
      "-alpha",
      "off",
      "-fx",
      `v==0 ? 0 : u/v - ${keyColor}/v + ${keyColor}`,
      tempUnblended,
    ]);

    // Step 5: Despill - limit green channel to remove remaining spill
    // Formula: g > (r+b)/2 ? (r+b)/2 : g
    await runMagick([
      tempUnblended,
      "-channel",
      "G",
      "-fx",
      "g>(r+b)/2 ? (r+b)/2 : g",
      "+channel",
      tempDespilled,
    ]);

    // Step 6: Apply refined alpha to despilled image
    await runMagick([
      tempDespilled,
      tempAlphaRef,
      "-alpha",
      "off",
      "-compose",
      "CopyOpacity",
      "-composite",
      outputPath,
    ]);

    await cleanup();
    return outputPath;
  } catch (err) {
    // Fallback: simple fuzz method + edge erosion
    console.log(
      `\x1b[33m  Advanced pipeline failed, using fallback...\x1b[0m`
    );
    await cleanup();

    await runMagick([
      inputPath,
      "-fuzz",
      `${fuzz}%`,
      "-transparent",
      chromaColor,
      "-channel",
      "A",
      "-morphology",
      "Erode",
      "Diamond:1",
      "+channel",
      outputPath,
    ]);
    return outputPath;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): Options {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
\x1b[36mNano Banana\x1b[0m - AI Image Generation CLI
Powered by Gemini 3 Pro Image Preview

\x1b[33mUsage:\x1b[0m
  nano-banana "your prompt"
  nano-banana "your prompt" --output filename
  nano-banana "your prompt" --ref reference.png
  nano-banana "edit this image to be darker" -r input.png
  nano-banana "combine these styles" -r style1.png -r style2.png

\x1b[33mOptions:\x1b[0m
  -o, --output      Output filename (without extension) [default: nano-gen-{timestamp}]
  -s, --size        Image size: 1K or 2K [default: 2K]
  -d, --dir         Output directory [default: current directory]
  -r, --ref         Reference image(s) - can use multiple times
  -t, --transparent Remove chroma key background (neon green by default)
  --chroma          Chroma key color to remove [default: #00FF00]
  --fuzz            Color tolerance percentage [default: 10]
  --api-key         Gemini API key (overrides env/file)
  -h, --help        Show this help

\x1b[33mExamples:\x1b[0m
  nano-banana "minimal dashboard UI with dark theme"
  nano-banana "make this image have a white background" -r screenshot.png
  nano-banana "combine these two UI styles" -r style1.png -r style2.png -o combined
  nano-banana "luxury product mockup" -o product -s 2K

\x1b[33mTransparent Assets:\x1b[0m
  nano-banana "robot mascot on solid neon green background" -t
  nano-banana "product icon, green screen background #00FF00" --transparent
  nano-banana "logo design on bright green" -t --fuzz 15

\x1b[33mAPI Key:\x1b[0m
  Set GEMINI_API_KEY in your environment, a .env file, or pass --api-key.
  Get a key at: https://aistudio.google.com/apikey
`);
    process.exit(0);
  }

  const options: Options = {
    prompt: "",
    output: `nano-gen-${Date.now()}`,
    size: "2K",
    outputDir: process.cwd(),
    referenceImages: [],
    transparent: false,
    chromaColor: "#00FF00",
    fuzz: 10,
    apiKey: undefined,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-o" || arg === "--output") {
      options.output = args[++i];
    } else if (arg === "-s" || arg === "--size") {
      const size = args[++i];
      if (size === "1K" || size === "2K") {
        options.size = size;
      }
    } else if (arg === "-d" || arg === "--dir") {
      options.outputDir = args[++i];
    } else if (arg === "-r" || arg === "--ref") {
      options.referenceImages.push(args[++i]);
    } else if (arg === "-t" || arg === "--transparent") {
      options.transparent = true;
    } else if (arg === "--chroma") {
      options.chromaColor = args[++i];
    } else if (arg === "--fuzz") {
      options.fuzz = parseInt(args[++i], 10);
    } else if (arg === "--api-key") {
      options.apiKey = args[++i];
    } else if (!arg.startsWith("-")) {
      options.prompt = arg;
    }
    i++;
  }

  if (!options.prompt) {
    console.error("\x1b[31mError:\x1b[0m No prompt provided");
    process.exit(1);
  }

  return options;
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

async function generateImage(options: Options): Promise<string[]> {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("\x1b[31mError:\x1b[0m GEMINI_API_KEY is required.");
    console.error("");
    console.error("Set it one of these ways:");
    console.error("  1. Export:    export GEMINI_API_KEY=your_key");
    console.error("  2. .env:     Create .env with GEMINI_API_KEY=your_key");
    console.error("  3. Flag:     nano-banana \"prompt\" --api-key your_key");
    console.error("  4. Config:   mkdir -p ~/.nano-banana && echo 'GEMINI_API_KEY=your_key' > ~/.nano-banana/.env");
    console.error("");
    console.error("Get a key at: https://aistudio.google.com/apikey");
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey });

  const config = {
    responseModalities: ["IMAGE", "TEXT"] as const,
    imageConfig: {
      imageSize: options.size,
    },
    tools: [{ googleSearch: {} }],
  };

  const model = "gemini-3-pro-image-preview";

  console.log("\x1b[36m[nano-banana]\x1b[0m Generating image...");
  console.log(`\x1b[90mPrompt: ${options.prompt}\x1b[0m`);
  console.log(`\x1b[90mSize: ${options.size}\x1b[0m`);

  if (options.referenceImages.length > 0) {
    console.log(
      `\x1b[90mReferences: ${options.referenceImages.join(", ")}\x1b[0m`
    );
  }
  console.log("");

  // Build parts array with images first, then text
  const parts: Array<
    { text: string } | { inlineData: { data: string; mimeType: string } }
  > = [];

  for (const imgPath of options.referenceImages) {
    try {
      const imageData = await loadImageAsBase64(imgPath);
      parts.push({ inlineData: imageData });
      console.log(`\x1b[32m+\x1b[0m Loaded reference: ${imgPath}`);
    } catch (err) {
      console.error(`\x1b[31mx\x1b[0m Failed to load: ${imgPath}`);
      throw err;
    }
  }

  parts.push({ text: options.prompt });

  const contents = [{ role: "user" as const, parts }];

  const response = await ai.models.generateContentStream({
    model,
    config,
    contents,
  });

  const savedFiles: string[] = [];
  let fileIndex = 0;

  if (!existsSync(options.outputDir)) {
    await mkdir(options.outputDir, { recursive: true });
  }

  for await (const chunk of response) {
    if (
      !chunk.candidates ||
      !chunk.candidates[0]?.content ||
      !chunk.candidates[0]?.content?.parts
    ) {
      continue;
    }

    for (const part of chunk.candidates[0].content.parts) {
      if (part.inlineData) {
        const inlineData = part.inlineData;
        const mimeType = inlineData.mimeType || "image/png";
        const ext = mimeType.split("/")[1] || "png";

        const fileName =
          fileIndex === 0
            ? `${options.output}.${ext}`
            : `${options.output}_${fileIndex}.${ext}`;

        const outputPath = join(options.outputDir, fileName);
        const buffer = Buffer.from(inlineData.data || "", "base64");

        await writeFile(outputPath, buffer);
        savedFiles.push(outputPath);
        fileIndex++;
      } else if (part.text) {
        console.log(`\x1b[90m${part.text}\x1b[0m`);
      }
    }
  }

  return savedFiles;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const options = parseArgs();

generateImage(options)
  .then(async (files) => {
    if (files.length === 0) {
      console.log("\x1b[33m[nano-banana]\x1b[0m No images generated");
      return;
    }

    let finalFiles = files;

    if (options.transparent) {
      console.log(
        `\n\x1b[36m[nano-banana]\x1b[0m Removing ${options.chromaColor} background...`
      );
      const processedFiles: string[] = [];

      for (const file of files) {
        try {
          const outputPath = await removeChromaKey(
            file,
            options.chromaColor,
            options.fuzz
          );
          processedFiles.push(outputPath);
          console.log(`  \x1b[32m+\x1b[0m Transparent: ${outputPath}`);
        } catch (err) {
          console.error(`  \x1b[31mx\x1b[0m Failed to process: ${file}`);
          processedFiles.push(file);
        }
      }

      finalFiles = processedFiles;
    }

    console.log(
      `\n\x1b[32m[nano-banana]\x1b[0m Generated ${finalFiles.length} image(s):`
    );
    finalFiles.forEach((f) => console.log(`  \x1b[32m+\x1b[0m ${f}`));
  })
  .catch((err) => {
    console.error("\x1b[31m[nano-banana] Error:\x1b[0m", err.message);
    process.exit(1);
  });
