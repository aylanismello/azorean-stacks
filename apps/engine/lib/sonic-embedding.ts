import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAP_EMBEDDING_DIMENSIONS,
  CLAP_SAMPLE_RATE,
  type ClapEmbedder,
  l2Normalize,
  meanNormalizedVectors,
} from "./clap";

export const SONIC_SEGMENT_COUNT = 3;
export const SONIC_SEGMENT_SECONDS = 20;
export const SONIC_WINDOW_SECONDS = 10;
export const MAX_SONIC_DURATION_SECONDS = 30 * 60;
export const SONIC_EMBEDDING_VERSION = "clap_3x20_region_10_window_v1";
export const SONIC_SEGMENT_FRACTIONS = [0.2, 0.5, 0.8] as const;

export interface SonicWindow {
  segmentStartSeconds: number;
  segmentEndSeconds: number;
  windowStartSeconds: number;
  windowEndSeconds: number;
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SonicEmbeddingResult {
  embedding: number[];
  windows: SonicWindow[];
  segmentEmbeddings: number[][];
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** Three deterministic 20-second regions, each represented by its centered fixed 10-second window. */
export function deterministicSonicWindows(durationSeconds: number): SonicWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Audio duration must be positive");
  const regionLength = Math.min(SONIC_SEGMENT_SECONDS, durationSeconds);
  const windowLength = Math.min(SONIC_WINDOW_SECONDS, durationSeconds);
  return SONIC_SEGMENT_FRACTIONS.map((fraction) => {
    const center = durationSeconds * fraction;
    const segmentStartSeconds = clamp(center - regionLength / 2, 0, durationSeconds - regionLength);
    const windowStartSeconds = clamp(
      segmentStartSeconds + (regionLength - windowLength) / 2,
      0,
      durationSeconds - windowLength,
    );
    return {
      segmentStartSeconds,
      segmentEndSeconds: segmentStartSeconds + regionLength,
      windowStartSeconds,
      windowEndSeconds: windowStartSeconds + windowLength,
    };
  });
}

export function extractFixedWindow(audio: DecodedAudio, window: SonicWindow): Float32Array {
  const expectedLength = Math.round(SONIC_WINDOW_SECONDS * audio.sampleRate);
  const start = Math.max(0, Math.round(window.windowStartSeconds * audio.sampleRate));
  const end = Math.min(audio.samples.length, start + expectedLength);
  const fixed = new Float32Array(expectedLength);
  fixed.set(audio.samples.subarray(start, end));
  return fixed;
}

export async function embedDecodedAudio(audio: DecodedAudio, embedder: ClapEmbedder): Promise<SonicEmbeddingResult> {
  if (audio.sampleRate !== CLAP_SAMPLE_RATE) throw new Error(`Decoded audio must be ${CLAP_SAMPLE_RATE} Hz mono`);
  const durationSeconds = audio.samples.length / audio.sampleRate;
  const windows = deterministicSonicWindows(durationSeconds);
  const segmentEmbeddings: number[][] = [];
  for (const window of windows) {
    const vector = await embedder.embedAudio(extractFixedWindow(audio, window), audio.sampleRate);
    segmentEmbeddings.push(l2Normalize(vector));
  }
  return { embedding: meanNormalizedVectors(segmentEmbeddings), windows, segmentEmbeddings };
}

export async function decodeAudioWithFfmpeg(inputPath: string): Promise<DecodedAudio> {
  const probe = Bun.spawn([
    "ffprobe", "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", inputPath,
  ], { stdout: "pipe", stderr: "pipe" });
  const [probeExitCode, probeStdout, probeStderr] = await Promise.all([
    probe.exited,
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  if (probeExitCode !== 0) throw new Error(probeStderr.trim() || `ffprobe exited ${probeExitCode}`);
  const durationSeconds = Number(probeStdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("ffprobe returned an invalid duration");
  if (durationSeconds > MAX_SONIC_DURATION_SECONDS) {
    throw new Error(`Audio exceeds the ${MAX_SONIC_DURATION_SECONDS}-second sonic embedding limit`);
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "azorean-sonic-decode-"));
  const outputPath = join(tempDirectory, "audio.f32le");
  try {
    const child = Bun.spawn([
      "ffmpeg", "-v", "error", "-y", "-i", inputPath,
      "-ac", "1", "-ar", String(CLAP_SAMPLE_RATE),
      "-t", String(MAX_SONIC_DURATION_SECONDS + 1 / CLAP_SAMPLE_RATE),
      "-f", "f32le", outputPath,
    ], { stdout: "ignore", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `ffmpeg exited ${exitCode}`);
    const bytes = await readFile(outputPath);
    const copied = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const samples = new Float32Array(copied);
    if (samples.length === 0) throw new Error("ffmpeg decoded no audio samples");
    if (samples.length > MAX_SONIC_DURATION_SECONDS * CLAP_SAMPLE_RATE) {
      throw new Error(`Audio exceeds the ${MAX_SONIC_DURATION_SECONDS}-second sonic embedding limit`);
    }
    return { samples, sampleRate: CLAP_SAMPLE_RATE };
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

export async function embedAudioFile(
  inputPath: string,
  embedder: ClapEmbedder,
  decoder: (path: string) => Promise<DecodedAudio> = decodeAudioWithFfmpeg,
): Promise<SonicEmbeddingResult> {
  return embedDecodedAudio(await decoder(inputPath), embedder);
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== CLAP_EMBEDDING_DIMENSIONS || right.length !== CLAP_EMBEDDING_DIMENSIONS) {
    throw new Error(`Cosine similarity requires two ${CLAP_EMBEDDING_DIMENSIONS}-dimensional vectors`);
  }
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += Number(left[index]) * Number(right[index]);
  return dot;
}

export async function describeWithVocabulary(
  embedding: number[],
  vocabulary: string[],
  embedder: ClapEmbedder,
  limit = 8,
): Promise<Array<{ label: string; score: number }>> {
  if (!embedder.embedText || vocabulary.length === 0 || limit <= 0) return [];
  const textEmbeddings = await embedder.embedText(vocabulary.map((label) => `a recording of ${label}`));
  return vocabulary
    .map((label, index) => ({ label, score: cosineSimilarity(embedding, textEmbeddings[index]) }))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}
