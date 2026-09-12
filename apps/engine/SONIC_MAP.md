# CLAP sonic map worker

The sonic-map runtime loads its heavyweight model dependency lazily so ordinary engine tests and scripts do not download a model.

## Runtime prerequisites

- `ffmpeg` and `ffprobe` on `PATH`
- `@xenova/transformers` 2.17.2 (declared in the engine package)
- Supabase service-role environment variables already used by the engine
- Optional `SONIC_STORAGE_BUCKET` (defaults to `tracks`)

The worker uses `Xenova/clap-htsat-unfused` at the immutable revision declared in `lib/clap.ts`. Model ID, model revision, embedding version, deterministic windows, and a local SHA-256 audio fingerprint are stored with each 512-dimensional vector. These vectors are isolated from `tracks.embedding`.

To keep each job bounded, the worker rejects source objects over 256 MiB and decoded audio over 30 minutes. Temporary source and decode files live in per-job private temporary directories and are removed on success or failure.

## Commands

```sh
bun run scripts/backfill-sonic.ts             # enqueue stored tracks without embeddings
bun run scripts/backfill-sonic.ts --force     # invalidate/re-enqueue every stored track
bun run scripts/sonic-worker.ts               # poll continuously
bun run scripts/sonic-worker.ts --once        # claim one batch and exit
bun run scripts/sonic-status.ts
bun run scripts/cluster-sonic.ts --clusters=8
```

The first production worker run downloads the pinned model ID/revision into the Transformers.js cache. Audio is downloaded only to a private local temporary file, decoded locally, and deleted after each job. Sound-label scores and sonic similarity are cosine-relative ordering signals, not probabilities. Active seeds and recent likes supply bounded positive sonic context; proximity to recent rejects supplies bounded avoidance. Explicit seed refreshes use only that exact seed so tangent attribution stays honest. Tests inject an embedder and never load or download the model.
