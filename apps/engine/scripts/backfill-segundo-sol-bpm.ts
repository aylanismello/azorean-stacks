#!/usr/bin/env bun
import { rm } from "node:fs/promises";
import { extname } from "node:path";
import { getSupabase } from "../lib/supabase";

const db = getSupabase();
const analyzer = `${import.meta.dir}/segundo-sol-sessions-sync.py`;

function validBpm(value: unknown): number | null {
  const bpm = Number(value);
  return Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? bpm : null;
}

async function analyze(track: Record<string, any>): Promise<boolean> {
  if (validBpm(track.metadata?.bpm)) return false;
  const backingTrack = Array.isArray(track.tracks) ? track.tracks[0] : track.tracks;
  const storagePath = track.audio_storage_path || backingTrack?.storage_path || null;
  if (!storagePath) return false;

  const bucket = track.audio_storage_path ? "segundo-sol-audio" : "tracks";
  const extension = extname(storagePath) || ".mp3";
  const tempPath = `/tmp/segundo-sol-bpm-${track.id}${extension}`;

  try {
    const { data: audio, error: downloadError } = await db.storage.from(bucket).download(storagePath);
    if (downloadError || !audio) throw new Error(downloadError?.message || "audio download failed");
    await Bun.write(tempPath, audio);

    const process = Bun.spawn(["python3", analyzer, "--analyze-file", tempPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `analyzer exited ${exitCode}`);
    const bpm = validBpm(JSON.parse(stdout).bpm);
    if (!bpm) return false;

    const { error: updateError } = await db
      .from("segundo_sol_episode_tracks")
      .update({
        metadata: {
          ...(track.metadata || {}),
          bpm,
          bpm_source: "local_audio_analysis",
        },
      })
      .eq("id", track.id)
      .eq("user_id", track.user_id);
    if (updateError) throw new Error(updateError.message);
    console.log(`✓ ${track.artist} — ${track.title}: ${bpm} BPM`);
    return true;
  } catch (error) {
    console.error(`✗ ${track.artist} — ${track.title}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await rm(tempPath, { force: true });
  }
}

const { data: tracks, error } = await db
  .from("segundo_sol_episode_tracks")
  .select("id, user_id, artist, title, audio_storage_path, metadata, tracks(storage_path)")
  .order("created_at", { ascending: true });
if (error) throw new Error(error.message);

let updated = 0;
for (const track of tracks || []) {
  if (await analyze(track)) updated += 1;
}
console.log(JSON.stringify({ checked: tracks?.length || 0, updated }));
