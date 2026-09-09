---
id: doc-1
title: 'Predictive Queue, Audio Cache, and Taste Algorithm Report'
type: specification
created_date: '2026-09-08 19:01'
updated_date: '2026-09-08 19:03'
tags:
  - architecture
  - audio-cache
  - taste-engine
  - discovery
---
# Predictive Queue, Audio Cache, and Taste Algorithm Report

**Status:** Proposed architecture and algorithm changes
**Prepared:** 2026-09-08
**Scope:** Preserve autonomous discovery and re-seeding while replacing download-everything storage with predictive, bounded audio caching.

## Executive decision

Yes: Azorean Stacks can keep searching NTS and Lot Radio, ingesting metadata, enriching candidates, learning from votes, and automatically re-seeding approved tracks exactly as a background system. Audio storage does not need to be coupled to discovery.

The recommended design is:

1. **Discover broadly as metadata.** Keep all useful candidate, episode, curator, seed-lineage, and scoring data in Supabase.
2. **Rank per user.** Continuously produce an ordered queue for the front page.
3. **Warm only the likely playback window.** Download the next 20–50 ranked tracks, maintaining at least 10 ready tracks ahead of the current position.
4. **Treat audio as a bounded cache.** Likes, super-likes, active seeds, and PicoDrops are permanent; ordinary candidates expire unless they remain highly ranked.
5. **Re-rank and refill after every meaningful event.** A vote, seed, re-seed, queue depletion, ranking refresh, or front-page session should enqueue a new warm-set calculation.

This preserves the product behavior while sharply reducing object-storage growth.

## What already works

The current repository already has most of the control plane:

- `apps/engine/scripts/watcher.ts` subscribes to new seeds and user-track events.
- Approved tracks are automatically turned into user-scoped seeds on `user_tracks` INSERT.
- The watcher runs NTS and Lot Radio discovery, metadata enrichment, curator radar every six hours, backlog repair, and background download drains.
- `/api/fyp` provides a ranked, diversified front-page queue.
- `GlobalPlayerProvider` supports browser-side audio preloading.
- The front page preloads the next playable track at 75% completion.
- The front page fetches another 20 tracks when three or fewer playable pending tracks remain.

The missing layer is **server-side predictive preparation**. Browser preloading can warm an existing audio URL, but it cannot help when the audio object has not been downloaded yet.

## Why the present downloader must change

Current code still couples discovery to permanent audio:

- The normal seed pipeline downloads every newly inserted, downloadable track.
- The priority seed pipeline downloads every downloadable track from its chosen episode.
- The independent download drain selects the oldest pending tracks without audio.
- `download.ts` downloads both pending and approved tracks in creation order.
- `/api/fyp` only returns rows with `storage_path`, so undownloaded high-ranked candidates cannot enter the front-page queue.

This is why storage grows with discovery volume rather than actual listening demand.

## Target architecture

### 1. Metadata candidate pool

Discovery and enrichment continue unchanged in spirit, but stop after metadata and source resolution:

- track identity and normalized artist/title
- ISRC/MusicBrainz/Spotify IDs when available
- source episode and curator
- all seed-lineage links and match types
- genres and future audio features
- playable-source URL and source confidence
- per-user score inputs

No audio download is required at this stage.

### 2. Per-user materialized queue

Create a durable queue table rather than recalculating an anonymous slice on every page request. Suggested fields:

- `user_id`, `track_id`, `rank`, `score`, `score_version`
- `state`: `ranked | preparing | ready | failed | consumed`
- `reason_components` JSONB
- `queued_at`, `prepared_at`, `expires_at`, `last_requested_at`
- unique `(user_id, track_id)` and an index on `(user_id, state, rank)`

The front page should read ready entries in queue order. This makes the next tracks knowable to both the UI and the engine.

### 3. Predictive warm-set worker

Maintain three thresholds per active user:

- **Target queue:** 50 ranked candidates
- **Warm target:** next 20 tracks downloaded
- **Safety floor:** never fewer than 10 ready tracks ahead

Triggers:

- front-page session starts or resumes
- initial queue creation
- like, reject, skip, or super-like
- new seed or automatic re-seed
- curator radar adds candidates
- queue drops below the safety floor
- scheduled refresh while the user is active

Priority order:

1. Current track requested but not ready
2. Next 5 queue positions
3. Positions 6–20
4. Permanent assets: super-likes, likes selected for PicoDrops, and active seeds
5. Everything else remains metadata-only

Use a small lease/claim table or atomic state transition so multiple watcher loops never download the same track concurrently.

### 4. Front-page behavior

Because the main product is the front page, optimize directly for that surface:

- On page load, return the first ready tracks immediately plus preparation state for the next ranked entries.
- In the background, touch the queue/session and request warm-set maintenance.
- After each vote, re-rank only the unplayed tail; never reorder the currently playing track or the next one already buffered.
- Continue browser preloading, but move it earlier: preload the next audio URL as soon as the current track starts, not only at 75%, when connection conditions permit.
- If an unexpected uncached track is opened, create a high-priority preparation request and show `preparing audio`; poll or subscribe until its signed URL is ready.
- Keep 10 ready tracks even if the browser closes, so the next session starts instantly.

### 5. Retention and eviction

Suggested defaults:

- **Permanent:** super-likes, PicoDrops, active seeds, and explicitly pinned/liked library assets.
- **Warm cache:** ranked queue entries through position 20.
- **Recent cache:** played or prepared tracks retained for 14 days.
- **Evictable:** rejected/bad-source immediately; skipped after 24 hours; unplayed candidates after 14 days.
- **Metadata:** retained indefinitely unless identified as garbage or duplicate.

Do not evict an object that is referenced by another permanent user state. Deduplicate audio by ISRC when trustworthy, then MusicBrainz/Spotify recording ID, then normalized artist/title plus duration or fingerprint.

## Taste findings that should change the algorithm

Historical legacy data contains 922 timestamped interactions: 313 likes, 393 rejects, and 216 skips. It is a proxy rather than a guaranteed main-account export, but the strongest effects are large enough to guide design.

### Seed neighborhood quality is the strongest available signal

High-yield examples:

- Ivy Lab — *Stars*: 16 likes / 0 rejects
- Parcels — *Everyroad*: 10/10
- Medasin — *Star Song*: 13/15
- Kiasmos — *Blurred*: 14/19

Low-yield examples:

- Jungle / Joy Anonymous — *JOY (Back On 74)*: 0/14
- Nico Georis — *Tears of Gold*: 7/43
- Alex Kassian — *Strings of Eden*: 16/74
- Jonwayne — *Andrew*: 12/45

**Change:** separate `seed_is_liked` from `seed_is_good_for_discovery`. Use a Bayesian-smoothed downstream approval rate and minimum sample count. A loved track may remain a taste reference while its expansion strength is reduced to zero.

### Show context outperforms broad genre labels

Strong reviewed NTS contexts include Fervent Moon (10/10), Tim Parker & Ivy Lab (14/14), and Erased Tapes (11/11). Weak contexts include The Slip (0/18), NTS Breakfast Show with Flo (0/18), The Outside Insight Hour (0/16), LDLDN (0/15), and Tom Furse (0/13).

**Change:** add a show/episode-series affinity distinct from curator identity. Apply empirical-Bayes smoothing so small samples do not dominate. Suppress repeated expansion from a context after enough decisive negative evidence.

### Broad genre weights are secondary

Higher historical approval appeared in footwork, downtempo, IDM, breakbeat, dub techno, minimal techno, and UK garage. Lower approval appeared in art pop, drone, neoclassical, minimalism, and generic ambient.

**Change:** retain genre only as a weak prior. Favor track-level and context-level evidence. The apparent preference is for movement, rhythmic intelligence, texture, and warmth—not simply “electronic” or “ambient.” Backlog task 6, audio feature analysis, would help represent this distinction with BPM, energy, danceability, acousticness, and timbral embeddings.

## Concrete code findings

### P0 — repair seed-lineage learning

`update-signals.ts` says tracks can be linked by `metadata.seed_id` or `seed_track_id`, but its seed-affinity calculation only reads `metadata.seed_id`. The watcher inserts `seed_track_id` and seed artist/title metadata, but not `metadata.seed_id`. New discoveries can therefore miss the seed-affinity signal entirely.

Recommended fix:

- Treat `episode_seeds` as the canonical many-to-many lineage.
- Score a candidate against every seed linked to its episode, with the specific `match_type`.
- Backfill lineage for legacy rows.
- Stop relying on a single seed ID buried in metadata.

### P0 — handle re-seeding on vote UPDATE

The watcher auto-creates a seed when an approved `user_tracks` row arrives as an INSERT. The API uses upsert, so changing an existing row from pending/listened/rejected to approved may produce an UPDATE instead. The general UPDATE subscription currently only handles super-likes.

Recommended fix:

- Subscribe to both INSERT and UPDATE for approval transitions.
- Only enqueue when `old.status !== "approved" && new.status === "approved"`.
- Make seed creation idempotent with a database uniqueness constraint covering user and canonical track identity.

### P0 — make weight tuning fully per-user

`tune-weights.ts` scopes the recent action list to a user, but builds approved-artist familiarity and episode approval statistics from global `tracks.status`. That can mix legacy/global votes into a supposedly per-user model.

Recommended fix:

- Derive artist familiarity, episode quality, and curator/show quality exclusively from that user's `user_tracks` joined to tracks.
- Require an explicit user ID in production jobs rather than silently choosing the first or most recent user.

### P1 — replace download-all paths with ranked preparation

Change these call sites:

- `watcher.ts` normal seed phase: enrich candidates, then enqueue only the top warm-set candidates.
- `watcher.ts` priority phase: do not download the entire chosen episode.
- `watcher.ts` download drain: order by active queue priority rather than `created_at`.
- `download.ts`: consume preparation requests instead of all pending rows.
- `/api/fyp`: read the user's materialized queue and expose preparation state, rather than excluding all rows without `storage_path` before ranking.

### P1 — improve ranking statistics

Use Bayesian smoothing and confidence:

- `smoothed_rate = (likes + prior_strength * global_rate) / (decisive_votes + prior_strength)`
- Keep `sample_count` beside every seed/show/curator rate.
- Shrink low-sample effects toward neutral.
- Add recency decay to adapt without erasing durable taste.
- Record score version and components for offline evaluation.

### P1 — evaluate with ranking metrics, not score intuition

The current global `taste_score` produced only about 0.523 pairwise AUC on historical explicit likes versus rejects. Median score was zero for both groups.

Before promoting a new scorer, run chronological offline evaluation:

- train on earlier votes, evaluate on later votes
- ROC-AUC and PR-AUC for like versus reject
- Precision@10 and Precision@20 for the front page
- skip-before-10% and completion/listen percentage
- source/seed coverage and diversity
- cache hit rate and playback-start latency

Do not tune and evaluate on the same interactions.

### P2 — replace rigid diversification

`diversifyTracks` forces every fifth item to be a medium-score wildcard. With weak or tied scores this can be arbitrary.

Recommended change:

- Use a scored exploration policy, initially about 10–15% of positions.
- Explore uncertain but plausible candidates, not merely middle-score candidates.
- Reduce exploration temporarily after rejection streaks.
- Preserve episode/artist repetition limits.

### P2 — fix queue accounting and signed URL strategy

- The `/api/fyp` total count is based on global `tracks.status = pending`, not the user's remaining queue.
- Signed URLs are generated serially per row and expire independently of cache retention.

Recommended change:

- Report per-user ready/preparing/ranked totals.
- Sign only the returned ready window.
- Refresh signed URLs just before playback when stale.

## Suggested delivery sequence

1. **Instrument first:** queue impressions, rank, score components/version, preparation latency, cache hit/miss, playback-start latency, and vote/listen outcome.
2. **Fix correctness:** seed lineage, approval UPDATE re-seeding, and fully per-user weight tuning.
3. **Add materialized queue and preparation request tables.** Keep the existing download-everything path available behind a feature flag.
4. **Run shadow ranking:** build predictive queues without changing the user experience; measure whether requested tracks would have been warm.
5. **Enable bounded warm-set downloads** for the main account only: target 20, floor 10, queue 50.
6. **Move audio objects to lower-cost storage and add eviction.** Metadata and auth remain in Supabase.
7. **Enable new scoring only after chronological evaluation beats the current baseline.**

## Acceptance targets

- At least 99% of front-page playback starts find audio already ready.
- Median playback start under 500 ms on a normal connection; p95 under 2 seconds.
- No more than 50 temporary audio objects per active user, excluding permanent assets.
- Discovery volume no longer causes proportional storage growth.
- Automatic seed and re-seed discovery continues even when no audio is downloaded.
- No cross-user vote or model leakage.
- Precision@20 exceeds the current scorer in chronological offline testing.

## Non-goals

- Do not stream hidden YouTube media as a playback backend.
- Do not delete metadata merely because audio is evicted.
- Do not let storage eviction remove PicoDrops or permanent liked assets.
- Do not change the front-page queue while the current track is playing in a way that causes jumps or repeats.

## Relevant repository paths

- `apps/engine/scripts/watcher.ts`
- `apps/engine/scripts/download.ts`
- `apps/engine/scripts/update-signals.ts`
- `apps/engine/scripts/tune-weights.ts`
- `apps/client/src/app/api/fyp/route.ts`
- `apps/client/src/app/page.tsx`
- `apps/client/src/components/GlobalPlayerProvider.tsx`
- `apps/client/src/lib/diversify.ts`
- `apps/client/supabase/migrations/018_taste_weights.sql`
- `backlog/tasks/task-6 - Add-audio-feature-analysis-BPM-energy-key-to-taste-scoring.md`
