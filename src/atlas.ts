import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const ATLAS_API_BASE = "https://api.atlascloud.ai/api/v1";
export const ATLAS_TEXT_MODEL = "google/nano-banana-2-lite/text-to-image-developer";
export const ATLAS_EDIT_MODEL = "google/nano-banana-2-lite/edit-developer";

const RETRYABLE_POLL_STATUSES = new Set([429, 500, 502, 503, 504]);
const TERMINAL_SUCCESS_STATUSES = new Set(["completed", "succeeded"]);
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "canceled", "cancelled"]);
const MAX_REFERENCE_IMAGES = 14;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const ATLAS_MEDIA_HOSTS = new Set([
  "atlascloud.ai",
  "atlas-media.oss-us-west-1.aliyuncs.com",
]);

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AtlasClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface AtlasGenerationOptions extends AtlasClientOptions {
  prompt: string;
  output: string;
  outputDir: string;
  size: string;
  aspectRatio?: string;
  referenceImages: string[];
  model?: string;
}

interface AtlasRuntime {
  apiKey: string;
  fetchImpl: FetchLike;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  maxPollAttempts: number;
}

interface DownloadedImage {
  bytes: Uint8Array;
  extension: string;
}

function toRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Atlas ${context} response is malformed`);
  }
  return value as Record<string, unknown>;
}

async function readEnvelope(response: Response, context: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Atlas ${context} response is not valid JSON`);
  }

  const envelope = toRecord(payload, context);
  return toRecord(envelope.data, context);
}

async function requireOk(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text()).slice(0, 500);
  throw new Error(`Atlas ${context} failed (${response.status})${detail ? `: ${detail}` : ""}`);
}

function createRuntime(options: AtlasClientOptions): AtlasRuntime {
  return {
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    pollIntervalMs: options.pollIntervalMs ?? 2_000,
    maxPollAttempts: options.maxPollAttempts ?? 120,
  };
}

function authorizationHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function assertAtlasMediaUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Atlas returned an invalid media URL");
  }

  const isAtlasHost =
    ATLAS_MEDIA_HOSTS.has(url.hostname) || url.hostname.endsWith(".atlascloud.ai");
  if (url.protocol !== "https:" || !isAtlasHost || url.username || url.password) {
    throw new Error(`Refusing untrusted Atlas media URL: ${url.origin}`);
  }
  return url;
}

async function uploadReference(filePath: string, runtime: AtlasRuntime): Promise<string> {
  const fileBytes = await readFile(filePath);
  if (fileBytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Atlas reference exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
  }
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), basename(filePath));

  const response = await runtime.fetchImpl(`${ATLAS_API_BASE}/model/uploadMedia`, {
    method: "POST",
    headers: { Authorization: `Bearer ${runtime.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await requireOk(response, "upload");
  const data = await readEnvelope(response, "upload");
  if (typeof data.download_url !== "string") {
    throw new Error("Atlas upload response does not contain download_url");
  }
  return assertAtlasMediaUrl(data.download_url).toString();
}

async function submitGeneration(
  payload: Record<string, unknown>,
  runtime: AtlasRuntime,
): Promise<string> {
  const response = await runtime.fetchImpl(`${ATLAS_API_BASE}/model/generateImage`, {
    method: "POST",
    headers: authorizationHeaders(runtime.apiKey),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await requireOk(response, "generation submission");
  const data = await readEnvelope(response, "generation submission");
  if (typeof data.id !== "string" || data.id.length === 0) {
    throw new Error("Atlas generation response does not contain a prediction id");
  }
  return data.id;
}

function extractOutputUrls(data: Record<string, unknown>): string[] {
  const rawOutputs = data.outputs ?? data.output;
  const outputs = typeof rawOutputs === "string" ? [rawOutputs] : rawOutputs;
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.some((item) => typeof item !== "string")) {
    throw new Error("Atlas completed prediction does not contain media outputs");
  }
  return outputs as string[];
}

async function pollPrediction(predictionId: string, runtime: AtlasRuntime): Promise<string[]> {
  const pollUrl = `${ATLAS_API_BASE}/model/prediction/${encodeURIComponent(predictionId)}`;

  for (let attempt = 0; attempt < runtime.maxPollAttempts; attempt++) {
    const response = await runtime.fetchImpl(pollUrl, {
      method: "GET",
      headers: authorizationHeaders(runtime.apiKey),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });

    if (!response.ok && RETRYABLE_POLL_STATUSES.has(response.status)) {
      if (attempt + 1 === runtime.maxPollAttempts) break;
      await runtime.sleep(runtime.pollIntervalMs * Math.min(2 ** attempt, 4));
      continue;
    }

    await requireOk(response, "prediction polling");
    const data = await readEnvelope(response, "prediction polling");
    const status = typeof data.status === "string" ? data.status.toLowerCase() : "";

    if (TERMINAL_SUCCESS_STATUSES.has(status)) {
      return extractOutputUrls(data);
    }
    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      const error = typeof data.error === "string" ? `: ${data.error}` : "";
      throw new Error(`Atlas generation ${status}${error}`);
    }

    if (attempt + 1 < runtime.maxPollAttempts) {
      await runtime.sleep(runtime.pollIntervalMs);
    }
  }

  throw new Error(`Atlas generation timed out after ${runtime.maxPollAttempts} polls`);
}

function extensionFor(contentType: string, url: URL): string {
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  if (byType[normalizedType]) return byType[normalizedType];

  const suffix = extname(url.pathname).slice(1).toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(suffix)) {
    return suffix === "jpeg" ? "jpg" : suffix;
  }
  throw new Error(`Atlas output is not a supported image (${normalizedType || "unknown type"})`);
}

async function downloadImage(rawUrl: string, runtime: AtlasRuntime): Promise<DownloadedImage> {
  const url = assertAtlasMediaUrl(rawUrl);
  // Deliberately omit Authorization: media hosts must never receive the API key.
  const response = await runtime.fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await requireOk(response, "media download");

  const advertisedSize = Number(response.headers.get("content-length") ?? 0);
  if (advertisedSize > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Atlas output exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
  }

  if (!response.body) throw new Error("Atlas output is empty");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.length;
    if (receivedBytes > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`Atlas output exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    chunks.push(value);
  }
  if (receivedBytes === 0) throw new Error("Atlas output is empty");

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    bytes,
    extension: extensionFor(response.headers.get("content-type") ?? "", url),
  };
}

export async function generateAtlasImages(options: AtlasGenerationOptions): Promise<string[]> {
  if (!options.apiKey) throw new Error("ATLASCLOUD_API_KEY is required for the Atlas provider");
  if (options.size !== "1K") {
    throw new Error("The Atlas Nano Banana 2 Lite routes currently support only --size 1K");
  }
  if (options.referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`The Atlas edit route accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
  }

  const runtime = createRuntime(options);
  const usesReferences = options.referenceImages.length > 0;
  const expectedModel = usesReferences ? ATLAS_EDIT_MODEL : ATLAS_TEXT_MODEL;
  if (options.model && options.model !== expectedModel) {
    throw new Error(`The Atlas provider supports ${expectedModel} for this workflow`);
  }

  const payload: Record<string, unknown> = {
    model: expectedModel,
    prompt: options.prompt,
    aspect_ratio: options.aspectRatio ?? "auto",
    resolution: "1k",
    thinking_level: "default",
  };

  if (usesReferences) {
    const uploadedReferences: string[] = [];
    for (const filePath of options.referenceImages) {
      uploadedReferences.push(await uploadReference(filePath, runtime));
    }
    payload.images = uploadedReferences;
  }

  const predictionId = await submitGeneration(payload, runtime);
  const outputUrls = await pollPrediction(predictionId, runtime);
  await mkdir(options.outputDir, { recursive: true });

  const savedFiles: string[] = [];
  for (const [index, outputUrl] of outputUrls.entries()) {
    const image = await downloadImage(outputUrl, runtime);
    const suffix = index === 0 ? "" : `_${index}`;
    const outputPath = join(options.outputDir, `${options.output}${suffix}.${image.extension}`);
    await writeFile(outputPath, image.bytes);
    savedFiles.push(outputPath);
  }
  return savedFiles;
}
