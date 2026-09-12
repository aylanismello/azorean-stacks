#!/usr/bin/env bun
import {
  createSupabaseArtworkRecoveryStore,
  recoverArtwork,
  type ArtworkRecoveryMetrics,
} from "../lib/artwork-recovery";
import { getSupabase } from "../lib/supabase";

interface CliOptions {
  dryRun: boolean;
  pageSize: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
}

function usage(): string {
  return [
    "Usage: bun run scripts/backfill-artwork.ts [options]",
    "",
    "Recover missing NTS episode artwork and use episode artwork for tracks",
    "whose cover_art_url is missing. Existing artwork is never overwritten.",
    "",
    "Options:",
    "  --dry-run             Discover changes without writing them",
    "  --page-size <n>       Keyset page size (default: 100)",
    "  --concurrency <n>     Maximum concurrent fetches/writes (default: 4)",
    "  --timeout-ms <n>      NTS request timeout in milliseconds (default: 10000)",
    "  --retries <n>         Retries after a transient failure (default: 2)",
    "  --help                Show this help",
  ].join("\n");
}

function positiveInteger(flag: string, raw: string | undefined, allowZero = false): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${flag} requires an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${flag} requires ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

export function parseArtworkRecoveryArgs(args: string[]): CliOptions | null {
  const options: CliOptions = {
    dryRun: false,
    pageSize: 100,
    concurrency: 4,
    timeoutMs: 10_000,
    retries: 2,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--page-size") options.pageSize = positiveInteger(arg, args[++index]);
    else if (arg === "--concurrency") options.concurrency = positiveInteger(arg, args[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = positiveInteger(arg, args[++index]);
    else if (arg === "--retries") options.retries = positiveInteger(arg, args[++index], true);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function progress(metrics: Readonly<ArtworkRecoveryMetrics>) {
  console.log(JSON.stringify({ event: "artwork-recovery-progress", ...metrics }));
}

async function main() {
  let options: CliOptions | null;
  try {
    options = parseArtworkRecoveryArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (!options) {
    console.log(usage());
    return;
  }

  console.log(`Artwork recovery${options.dryRun ? " (dry run)" : ""}`);
  const metrics = await recoverArtwork({
    store: createSupabaseArtworkRecoveryStore(getSupabase()),
    dryRun: options.dryRun,
    pageSize: options.pageSize,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    onProgress: progress,
  });
  console.log(JSON.stringify({ event: "artwork-recovery-complete", dryRun: options.dryRun, ...metrics }, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Artwork recovery failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
