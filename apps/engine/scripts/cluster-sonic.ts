#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";
import { CLAP_MODEL_ID, CLAP_MODEL_REVISION } from "../lib/clap";
import { SONIC_EMBEDDING_VERSION } from "../lib/sonic-embedding";

export interface ClusterPoint { id: string; vector: number[] }

function squaredDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return sum;
}

function mean(points: ClusterPoint[], dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const point of points) {
    for (let index = 0; index < dimensions; index += 1) vector[index] += point.vector[index];
  }
  return vector.map((value) => value / points.length);
}

/** Deterministic farthest-first initialization and stable k-means assignments. */
export function deterministicKMeans(points: ClusterPoint[], requestedClusters: number, iterations = 50): number[] {
  if (points.length === 0) return [];
  const dimensions = points[0].vector.length;
  if (!Number.isFinite(requestedClusters) || requestedClusters <= 0) throw new Error("Cluster count must be positive");
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error("Iterations must be positive");
  if (dimensions === 0 || !points.every((point) =>
    point.vector.length === dimensions && point.vector.every(Number.isFinite)
  )) throw new Error("Embeddings must have equal, finite dimensions");
  const clusterCount = Math.max(1, Math.min(Math.floor(requestedClusters), points.length));
  const centroids: number[][] = [points[0].vector.slice()];
  while (centroids.length < clusterCount) {
    let farthestIndex = 0;
    let farthestDistance = -1;
    points.forEach((point, index) => {
      const distance = Math.min(...centroids.map((centroid) => squaredDistance(point.vector, centroid)));
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    });
    centroids.push(points[farthestIndex].vector.slice());
  }

  let assignments = new Array<number>(points.length).fill(-1);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = points.map((point) => {
      let winner = 0;
      let best = squaredDistance(point.vector, centroids[0]);
      for (let cluster = 1; cluster < centroids.length; cluster += 1) {
        const distance = squaredDistance(point.vector, centroids[cluster]);
        if (distance < best) { best = distance; winner = cluster; }
      }
      return winner;
    });
    if (next.every((cluster, index) => cluster === assignments[index])) break;
    assignments = next;
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const members = points.filter((_, index) => assignments[index] === cluster);
      if (members.length > 0) centroids[cluster] = mean(members, dimensions);
    }
  }
  return assignments;
}

export function parsePgVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    const parsed = value.map(Number);
    if (parsed.length === 0 || !parsed.every(Number.isFinite)) throw new Error("Invalid pgvector representation");
    return parsed;
  }
  if (typeof value !== "string") throw new Error("Unexpected pgvector representation");
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("Invalid pgvector representation");
  const parsed = value.slice(1, -1).split(",").map(Number);
  if (parsed.length === 0 || !parsed.every(Number.isFinite)) throw new Error("Invalid pgvector representation");
  return parsed;
}

async function main() {
  const db = getSupabase();
  const points: ClusterPoint[] = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("track_sonic_embeddings")
      .select("track_id, embedding")
      .eq("model_id", CLAP_MODEL_ID)
      .eq("model_revision", CLAP_MODEL_REVISION)
      .eq("embedding_version", SONIC_EMBEDDING_VERSION)
      .order("track_id")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    points.push(...(data || []).map((row) => ({ id: row.track_id, vector: parsePgVector(row.embedding) })));
    if (!data || data.length < pageSize) break;
  }
  if (points.length === 0) {
    console.log(JSON.stringify({ embeddings: 0, clusters: 0 }));
    return;
  }
  const clusterArg = process.argv.find((argument) => argument.startsWith("--clusters="));
  const requested = clusterArg ? Number(clusterArg.split("=")[1]) : Math.ceil(Math.sqrt(points.length / 2));
  const clusterCount = Math.max(1, Math.min(Math.floor(Number.isFinite(requested) ? requested : 8), 32, points.length));
  const assignments = deterministicKMeans(points, clusterCount);
  for (let index = 0; index < points.length; index += 1) {
    const { error: updateError } = await db
      .from("track_sonic_embeddings")
      .update({ cluster_id: assignments[index] })
      .eq("track_id", points[index].id);
    if (updateError) throw new Error(`${points[index].id}: ${updateError.message}`);
  }
  console.log(JSON.stringify({ embeddings: points.length, clusters: clusterCount }));
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
