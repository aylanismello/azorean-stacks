export const CLAP_MODEL_ID = "Xenova/clap-htsat-unfused";
// Pin the exact converted checkpoint so stored vectors remain comparable over time.
export const CLAP_MODEL_REVISION = "c28f2883575e590e04d3146ff0713c2448d691ba";
export const CLAP_EMBEDDING_DIMENSIONS = 512;
export const CLAP_SAMPLE_RATE = 48_000;

export type NumericVector = ArrayLike<number>;

export interface ClapEmbedder {
  embedAudio(audio: Float32Array, sampleRate?: number): Promise<number[]>;
  embedText?(texts: string[]): Promise<number[][]>;
}

interface ClapTransformersRuntime {
  AutoProcessor: { from_pretrained(modelId: string, options: { revision: string }): Promise<any> };
  ClapAudioModelWithProjection: { from_pretrained(modelId: string, options: { revision: string }): Promise<any> };
  AutoTokenizer: { from_pretrained(modelId: string, options: { revision: string }): Promise<any> };
  ClapTextModelWithProjection: { from_pretrained(modelId: string, options: { revision: string }): Promise<any> };
}

export function l2Normalize(vector: NumericVector, dimensions = CLAP_EMBEDDING_DIMENSIONS): number[] {
  if (vector.length !== dimensions) {
    throw new Error(`Expected ${dimensions}-dimensional CLAP vector, received ${vector.length}`);
  }
  let squaredNorm = 0;
  const values = Array.from(vector, (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("CLAP vector contains a non-finite value");
    squaredNorm += numeric * numeric;
    return numeric;
  });
  if (squaredNorm === 0) throw new Error("Cannot normalize an all-zero CLAP vector");
  const norm = Math.sqrt(squaredNorm);
  return values.map((value) => value / norm);
}

export function meanNormalizedVectors(vectors: NumericVector[]): number[] {
  if (vectors.length === 0) throw new Error("At least one CLAP vector is required");
  const sum = new Array<number>(CLAP_EMBEDDING_DIMENSIONS).fill(0);
  for (const vector of vectors) {
    const normalized = l2Normalize(vector);
    for (let index = 0; index < sum.length; index += 1) sum[index] += normalized[index];
  }
  return l2Normalize(sum);
}

function tensorRows(value: any): number[][] {
  const tensor = value?.audio_embeds ?? value?.text_embeds ?? value?.last_hidden_state ?? value;
  const data = tensor?.data ?? tensor;
  if (!data || typeof data.length !== "number") throw new Error("CLAP returned no embedding tensor");
  const dimensions: number[] | undefined = tensor?.dims;
  if (dimensions && dimensions.length >= 2) {
    const width = dimensions[dimensions.length - 1];
    const rows: number[][] = [];
    for (let offset = 0; offset < data.length; offset += width) rows.push(Array.from(data.slice(offset, offset + width)));
    return rows;
  }
  return [Array.from(data)];
}

/** Loads Transformers.js only when the production embedder is first requested. */
export async function createXenovaClapEmbedder(
  modelId = CLAP_MODEL_ID,
  revision = CLAP_MODEL_REVISION,
  injectedRuntime?: ClapTransformersRuntime,
): Promise<ClapEmbedder> {
  // Function-based import keeps the heavyweight runtime out of ordinary test startup.
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const transformers: ClapTransformersRuntime = injectedRuntime || await dynamicImport("@xenova/transformers").catch((error) => {
    throw new Error(
      `@xenova/transformers is required by the sonic worker (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  const [processor, audioModel] = await Promise.all([
    transformers.AutoProcessor.from_pretrained(modelId, { revision }),
    transformers.ClapAudioModelWithProjection.from_pretrained(modelId, { revision }),
  ]);
  let textRuntime: Promise<{ tokenizer: any; model: any }> | undefined;
  const getTextRuntime = () => textRuntime ||= Promise.all([
    transformers.AutoTokenizer.from_pretrained(modelId, { revision }),
    transformers.ClapTextModelWithProjection.from_pretrained(modelId, { revision }),
  ]).then(([tokenizer, model]) => ({ tokenizer, model }));

  return {
    async embedAudio(audio: Float32Array, sampleRate = CLAP_SAMPLE_RATE) {
      if (sampleRate !== CLAP_SAMPLE_RATE) throw new Error(`CLAP audio must be ${CLAP_SAMPLE_RATE} Hz`);
      const inputs = await processor(audio);
      const output = await audioModel(inputs);
      return l2Normalize(tensorRows(output?.audio_embeds ?? output)[0]);
    },
    async embedText(texts: string[]) {
      if (texts.length === 0) return [];
      const { tokenizer, model } = await getTextRuntime();
      const inputs = tokenizer(texts, { padding: true, truncation: true });
      const output = await model(inputs);
      const rows = tensorRows(output?.text_embeds ?? output);
      if (rows.length !== texts.length) throw new Error(`Expected ${texts.length} text embeddings, received ${rows.length}`);
      return rows.map((row) => l2Normalize(row));
    },
  };
}
