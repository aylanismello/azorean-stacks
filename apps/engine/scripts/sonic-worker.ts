#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import vocabulary from "../data/clap-sound-vocabulary.json";
import {
  CLAP_MODEL_ID,
  CLAP_MODEL_REVISION,
  createXenovaClapEmbedder,
  type ClapEmbedder,
} from "../lib/clap";
import { describeWithVocabulary, embedAudioFile, SONIC_EMBEDDING_VERSION } from "../lib/sonic-embedding";
import { getSupabase } from "../lib/supabase";

export const MAX_SONIC_SOURCE_BYTES = 256 * 1024 * 1024;

interface SonicJob {
  job_id: string;
  track_id: string;
  storage_path: string;
  lease_token: string;
  lease_generation: number;
  attempts: number;
}

export interface WorkerDependencies {
  db: ReturnType<typeof getSupabase>;
  embedder: ClapEmbedder;
  bucket: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failJob(dependencies: WorkerDependencies, owner: string, job: SonicJob, error: unknown) {
  const { data, error: rpcError } = await dependencies.db.rpc("fail_sonic_embedding_job", {
    p_job_id: job.job_id,
    p_owner: owner,
    p_lease_token: job.lease_token,
    p_lease_generation: job.lease_generation,
    p_error: errorMessage(error),
  });
  if (rpcError) throw new Error(`Could not fail sonic job ${job.job_id}: ${rpcError.message}`);
  if (!data) console.warn(`Lease was fenced before failure could be recorded for ${job.job_id}`);
}

export async function processSonicJob(
  dependencies: WorkerDependencies,
  owner: string,
  job: SonicJob,
): Promise<boolean> {
  const extension = extname(job.storage_path) || ".audio";
  const tempDirectory = await mkdtemp(join(tmpdir(), "azorean-sonic-source-"));
  const tempPath = join(tempDirectory, `${job.track_id}-${randomUUID()}${extension}`);
  try {
    const { data: audio, error: downloadError } = await dependencies.db.storage
      .from(dependencies.bucket)
      .download(job.storage_path);
    if (downloadError || !audio) throw new Error(downloadError?.message || "stored audio download failed");
    if (audio.size > MAX_SONIC_SOURCE_BYTES) {
      throw new Error(`Stored audio exceeds the ${MAX_SONIC_SOURCE_BYTES}-byte sonic worker limit`);
    }
    const bytes = new Uint8Array(await audio.arrayBuffer());
    await Bun.write(tempPath, bytes);

    const result = await embedAudioFile(tempPath, dependencies.embedder);
    const labels = await describeWithVocabulary(result.embedding, vocabulary, dependencies.embedder);
    const fingerprint = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const { data, error } = await dependencies.db.rpc("complete_sonic_embedding_job", {
      p_job_id: job.job_id,
      p_owner: owner,
      p_lease_token: job.lease_token,
      p_lease_generation: job.lease_generation,
      p_embedding: `[${result.embedding.join(",")}]`,
      p_model_id: CLAP_MODEL_ID,
      p_model_revision: CLAP_MODEL_REVISION,
      p_embedding_version: SONIC_EMBEDDING_VERSION,
      p_segment_windows: result.windows,
      p_sound_labels: labels,
      p_audio_fingerprint: fingerprint,
    });
    if (error) throw new Error(error.message);
    if (!data) {
      console.warn(`Lease was fenced before completion for ${job.track_id}`);
      return false;
    }
    console.log(`embedded ${job.track_id} (${labels.slice(0, 3).map(({ label }) => label).join(", ")})`);
    return true;
  } catch (error) {
    console.error(`sonic job ${job.job_id} failed: ${errorMessage(error)}`);
    await failJob(dependencies, owner, job, error);
    return false;
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

export async function runSonicWorker(options: {
  once?: boolean;
  batchSize?: number;
  pollMilliseconds?: number;
  dependencies?: WorkerDependencies;
} = {}) {
  const owner = randomUUID();
  const dependencies = options.dependencies || {
    db: getSupabase(),
    embedder: await createXenovaClapEmbedder(),
    bucket: process.env.SONIC_STORAGE_BUCKET || "tracks",
  };
  const batchSize = Math.max(1, Math.min(options.batchSize || 2, 25));
  const pollMilliseconds = Math.max(250, options.pollMilliseconds || 5_000);

  do {
    const { data, error } = await dependencies.db.rpc("claim_sonic_embedding_jobs", {
      p_owner: owner,
      p_limit: batchSize,
      p_lease_seconds: 3600,
    });
    if (error) throw new Error(error.message);
    const jobs = (data || []) as SonicJob[];
    if (jobs.length === 0) {
      if (options.once) return;
      await Bun.sleep(pollMilliseconds);
      continue;
    }
    for (const job of jobs) await processSonicJob(dependencies, owner, job);
  } while (!options.once);
}

if (import.meta.main) {
  const once = process.argv.includes("--once");
  const batchArg = process.argv.find((argument) => argument.startsWith("--batch="));
  runSonicWorker({ once, batchSize: batchArg ? Number(batchArg.split("=")[1]) : undefined })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
