import { describe, expect, test } from "bun:test";
import { CLAP_EMBEDDING_DIMENSIONS, createXenovaClapEmbedder, l2Normalize } from "./clap";
import {
  deterministicSonicWindows,
  embedDecodedAudio,
  extractFixedWindow,
  SONIC_WINDOW_SECONDS,
} from "./sonic-embedding";

const basis = (index: number) => {
  const vector = new Array<number>(CLAP_EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
};

describe("CLAP vector invariants", () => {
  test("produces a 512-dimensional L2-normalized vector", () => {
    const normalized = l2Normalize(new Array(CLAP_EMBEDDING_DIMENSIONS).fill(2));
    expect(normalized).toHaveLength(512);
    expect(Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 12);
  });

  test("rejects malformed and all-zero output", () => {
    expect(() => l2Normalize([1, 2, 3])).toThrow("512-dimensional");
    expect(() => l2Normalize(new Array(512).fill(0))).toThrow("all-zero");
  });

  test("loads audio and text model files with isolated options", async () => {
    const vector = new Float32Array(CLAP_EMBEDDING_DIMENSIONS).fill(1);
    const runtime = {
      AutoProcessor: {
        async from_pretrained(_modelId: string, options: Record<string, string>) {
          options.model_file_name = "processor-mutated";
          return async () => ({ input_features: true });
        },
      },
      ClapAudioModelWithProjection: {
        async from_pretrained(_modelId: string, options: Record<string, string>) {
          expect(options.model_file_name).toBeUndefined();
          options.model_file_name = "audio_model";
          return async () => ({ audio_embeds: { dims: [1, 512], data: vector } });
        },
      },
      AutoTokenizer: {
        async from_pretrained(_modelId: string, options: Record<string, string>) {
          expect(options.model_file_name).toBeUndefined();
          return () => ({ input_ids: true });
        },
      },
      ClapTextModelWithProjection: {
        async from_pretrained(_modelId: string, options: Record<string, string>) {
          expect(options.model_file_name).toBeUndefined();
          return async () => ({ text_embeds: { dims: [1, 512], data: vector } });
        },
      },
    };
    const embedder = await createXenovaClapEmbedder("test-model", "test-revision", runtime);
    expect(await embedder.embedAudio(new Float32Array(480_000))).toHaveLength(512);
    expect(await embedder.embedText?.(["a recording of a pure tone"])).toHaveLength(1);
  });
});

describe("deterministic sonic windows", () => {
  test("represents three deterministic 20-second regions with centered 10-second windows", () => {
    expect(deterministicSonicWindows(100)).toEqual([
      { segmentStartSeconds: 10, segmentEndSeconds: 30, windowStartSeconds: 15, windowEndSeconds: 25 },
      { segmentStartSeconds: 40, segmentEndSeconds: 60, windowStartSeconds: 45, windowEndSeconds: 55 },
      { segmentStartSeconds: 70, segmentEndSeconds: 90, windowStartSeconds: 75, windowEndSeconds: 85 },
    ]);
  });

  test("pads short tracks to a fixed model window", () => {
    const sampleRate = 10;
    const audio = { sampleRate, samples: new Float32Array(80).fill(1) };
    const [window] = deterministicSonicWindows(8);
    const extracted = extractFixedWindow(audio, window);
    expect(extracted).toHaveLength(SONIC_WINDOW_SECONDS * sampleRate);
    expect(Array.from(extracted.slice(0, 80)).every((value) => value === 1)).toBe(true);
    expect(Array.from(extracted.slice(80)).every((value) => value === 0)).toBe(true);
  });

  test("uses an injected embedder and averages exactly three normalized segment vectors", async () => {
    let calls = 0;
    const embedder = {
      async embedAudio(audio: Float32Array, sampleRate?: number) {
        expect(audio).toHaveLength(SONIC_WINDOW_SECONDS * 48_000);
        expect(sampleRate).toBe(48_000);
        return basis(calls++);
      },
    };
    const result = await embedDecodedAudio(
      { sampleRate: 48_000, samples: new Float32Array(48_000) },
      embedder,
    );
    expect(calls).toBe(3);
    expect(result.windows).toHaveLength(3);
    expect(result.segmentEmbeddings).toHaveLength(3);
    expect(result.embedding.slice(0, 3)).toEqual([
      1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3),
    ]);
    expect(Math.sqrt(result.embedding.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 12);
  });
});
