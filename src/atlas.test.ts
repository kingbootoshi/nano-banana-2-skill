import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATLAS_EDIT_MODEL,
  ATLAS_TEXT_MODEL,
  generateAtlasImages,
} from "./atlas.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nano-banana-atlas-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Atlas provider", () => {
  test("submits text generation once, polls to completion, and downloads without credentials", async () => {
    const outputDir = await createTemporaryDirectory();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      jsonResponse({ id: "prediction-1" }),
      jsonResponse({ status: "processing" }),
      jsonResponse({ status: "completed", outputs: ["https://atlas-media.oss-us-west-1.aliyuncs.com/result.png"] }),
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png", "content-length": "4" },
      }),
    ];

    const files = await generateAtlasImages({
      apiKey: "atlas-test-key",
      prompt: "pixel art sword",
      output: "sword",
      outputDir,
      size: "1K",
      aspectRatio: "1:1",
      referenceImages: [],
      pollIntervalMs: 0,
      sleep: async () => {},
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    });

    expect(files).toEqual([join(outputDir, "sword.png")]);
    expect(requests.filter((request) => request.init?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: ATLAS_TEXT_MODEL,
      prompt: "pixel art sword",
      aspect_ratio: "1:1",
      resolution: "1k",
      thinking_level: "default",
    });
    expect(requests.at(-1)?.url).toBe("https://atlas-media.oss-us-west-1.aliyuncs.com/result.png");
    expect(requests.at(-1)?.init?.headers).toBeUndefined();
    expect(requests.at(-1)?.init?.redirect).toBe("error");
  });

  test("uploads references sequentially and uses the edit schema", async () => {
    const outputDir = await createTemporaryDirectory();
    const referencePath = join(outputDir, "reference.png");
    await writeFile(referencePath, new Uint8Array([1, 2, 3]));
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      jsonResponse({ download_url: "https://uploads.atlascloud.ai/reference.png" }),
      jsonResponse({ id: "prediction-edit" }),
      jsonResponse({ status: "succeeded", output: "https://cdn.atlascloud.ai/edited.webp" }),
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }),
    ];

    await generateAtlasImages({
      apiKey: "atlas-test-key",
      prompt: "make it brighter",
      output: "edited",
      outputDir,
      size: "1K",
      referenceImages: [referencePath],
      pollIntervalMs: 0,
      sleep: async () => {},
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    });

    expect(requests[0].url).toEndWith("/model/uploadMedia");
    expect(requests[0].init?.body).toBeInstanceOf(FormData);
    const submitBody = JSON.parse(String(requests[1].init?.body));
    expect(submitBody.model).toBe(ATLAS_EDIT_MODEL);
    expect(submitBody.images).toEqual(["https://uploads.atlascloud.ai/reference.png"]);
  });

  test("never retries a failed generation POST", async () => {
    let calls = 0;
    await expect(generateAtlasImages({
      apiKey: "atlas-test-key",
      prompt: "test",
      output: "test",
      outputDir: await createTemporaryDirectory(),
      size: "1K",
      referenceImages: [],
      fetchImpl: async () => {
        calls++;
        return new Response("unavailable", { status: 503 });
      },
    })).rejects.toThrow("generation submission failed (503)");
    expect(calls).toBe(1);
  });

  test("retries retryable polling GET responses within the configured bound", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const responses = [
      jsonResponse({ id: "prediction-retry" }),
      new Response("unavailable", { status: 503 }),
      jsonResponse({ status: "completed", outputs: ["https://cdn.atlascloud.ai/retry.jpg"] }),
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }),
    ];

    await generateAtlasImages({
      apiKey: "atlas-test-key",
      prompt: "test",
      output: "test",
      outputDir: await createTemporaryDirectory(),
      size: "1K",
      referenceImages: [],
      pollIntervalMs: 10,
      maxPollAttempts: 3,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      fetchImpl: async () => {
        calls++;
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    });

    expect(calls).toBe(4);
    expect(sleeps).toEqual([10]);
  });

  test("rejects non-Atlas output hosts before downloading", async () => {
    const responses = [
      jsonResponse({ id: "prediction-host" }),
      jsonResponse({ status: "completed", outputs: ["https://example.com/result.png"] }),
    ];

    await expect(generateAtlasImages({
      apiKey: "atlas-test-key",
      prompt: "test",
      output: "test",
      outputDir: await createTemporaryDirectory(),
      size: "1K",
      referenceImages: [],
      pollIntervalMs: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    })).rejects.toThrow("Refusing untrusted Atlas media URL");
  });

  test("rejects unsupported size and excessive references before network access", async () => {
    let calls = 0;
    const baseOptions = {
      apiKey: "atlas-test-key",
      prompt: "test",
      output: "test",
      outputDir: await createTemporaryDirectory(),
      fetchImpl: async () => {
        calls++;
        throw new Error("network should not be called");
      },
    };

    await expect(generateAtlasImages({
      ...baseOptions,
      size: "2K",
      referenceImages: [],
    })).rejects.toThrow("only --size 1K");

    await expect(generateAtlasImages({
      ...baseOptions,
      size: "1K",
      referenceImages: Array.from({ length: 15 }, (_, index) => `ref-${index}.png`),
    })).rejects.toThrow("at most 14 reference images");
    expect(calls).toBe(0);
  });
});
