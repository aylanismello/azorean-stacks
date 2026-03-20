# Azorean Stacks — Source of Truth

## Purpose

A.F.M (Fluindo) is a DJ who produces music for his mix show. He needs to constantly discover new tracks on the bleeding edge of the underground. The core insight: **if a DJ on NTS played a song I like, they probably played other songs I'd like too.**

Azorean Stacks automates this by:
1. Taking songs A.F.M already likes ("seeds")
2. Finding NTS radio episodes where those songs were played
3. Pulling every other track from those episodes
4. Ranking them by likelihood A.F.M will want to DJ them
5. Letting him listen, vote, and discover

## Data Pipeline

```
Seeds (manual input)
  ↓
Discover (find NTS episodes containing seed tracks)
  ↓
Episodes + Tracklists (scraped from NTS)
  ↓
Tracks (individual songs extracted from episodes)
  ↓
Enrichment (find Spotify/YouTube URLs for each track)
  ↓
Download (grab audio via yt-dlp, store in Supabase Storage)
  ↓
Scoring (rank tracks by taste profile)
  ↓
Player (serve ranked tracks for listening + voting)
  ↓
Feedback loop (votes update taste signals → better scoring)
```

## Seeds

A **seed** is a track A.F.M likes. Added manually via Spotify URL or playlist import.

- `seeds` table: `id`, `user_id`, `track_id`, `artist`, `title`, `source` ("manual" or "re-seed"), `active`
- A **re-seed** is a track discovered through the pipeline that A.F.M liked enough to plant as a new seed. It feeds back into discovery.

### Seed → Episode matching

Two match types:
- **full match**: the exact seed track (artist + title) appears in the episode's tracklist
- **artist match**: a different track by the same artist appears in the episode's tracklist

Stored in `episode_seeds` table with `match_type`.

## Engine (runner.sh)

A persistent bash loop running on the Mac mini. Runs continuously with 5-second sleep between cycles.

### What runs each cycle:

1. **watcher.ts** (background process)
   - Subscribes to Supabase Realtime
   - Watches for new seeds being added
   - Auto-triggers discovery for new seeds
   - Monitors health, reconnects on disconnect

2. **discover** (per cycle)
   - For each active seed, searches NTS for matching episodes
   - Scrapes episode tracklists
   - Inserts tracks into `tracks` table via `episode_tracks` junction
   - Validates match type before ingesting

3. **download** (per cycle, 55-minute window)
   - Finds tracks with Spotify/YouTube URLs but no local audio
   - Downloads via yt-dlp to local file, uploads to Supabase Storage
   - Concurrency: 15 parallel downloads
   - Max 200 tracks per cycle

### Periodic/manual scripts (NOT in the main loop):

- **update-signals.ts** — Pre-computes `taste_score` for all pending tracks. Should be run periodically (cron or manual).
- **tune-weights.ts** — Adjusts the 5 dynamic weights based on voting history. Should be run after significant voting sessions.
- **radar-curator.ts** — Curator-based discovery (experimental)
- **backfill-*.ts** — One-time data repair scripts

## Scoring Systems

### ⚠️ CURRENT STATE: Two separate systems that should be unified

#### System 1: Pre-computed taste_score (FYP / genre views)

**Where:** `update-signals.ts` → writes to `tracks.taste_score` column
**When:** Run manually or via cron (NOT every cycle)
**Used by:** `/api/tracks?order_by=taste_score` (FYP, genre stacks)

Signals and weights:
| Signal | Weight | Description |
|--------|--------|-------------|
| Artist | 25% | Tracks by artists you've approved before score higher |
| Genre | 30% | Tracks in genres you've approved score higher |
| Seed affinity | 20% | Tracks from high-performing seeds score higher |
| Curator | 15% | Tracks from curators (DJs) whose episodes you've liked |
| Episode density | 10% | Tracks from episodes where you approved multiple tracks |

This score is a number between -1 and 1 stored directly on the track row.

#### System 2: Real-time ranked queue (Seed stacks)

**Where:** `/api/stacks/[id]/queue/route.ts` → computed per request
**When:** Every time a seed stack is loaded
**Used by:** Seed stack play view

Signals and weights (dynamic, stored in `taste_weights` table):
| Signal | Default | Description |
|--------|---------|-------------|
| Seed proximity | 30 pts | full_match > artist_match > unknown |
| Source quality | 25 pts | Episode approval rate from past voting |
| Artist familiarity | 20 pts | Artist appears in other approved tracks |
| Recency | 15 pts | Newer discoveries get a slight boost |
| Co-occurrence | 10 pts | Artist appeared across multiple seed episodes |

Plus modifiers:
- **Negative penalties**: rejected artist (-10), bad episode (-15), bad curator (-5)
- **Momentum**: 3+ approvals from same episode → +15, 3+ skips → -10

### ❓ What should change

Both systems measure similar things (does this track match the user's taste?) but use different signals, weights, and code paths. The FYP view — which is the PRIMARY discovery surface — runs on the simpler, less adaptive system.

**Proposal:** Unify into one scoring system that:
- Uses the best signals from both (artist, genre, seed affinity, curator, episode density, co-occurrence)
- Pre-computes scores in the engine (like System 1) so they're fast
- But includes the negative signals and diversity rules from System 2
- Re-computes after each voting session (not real-time mid-session)
- Taste signals breakdown is stored per-track so the UI can always show them

## User Actions (Voting)

When listening to tracks, the user can:

| Action | Status | Algorithm effect |
|--------|--------|-----------------|
| ❤️ Like (approve) | `approved` | Positive signal for artist, genre, seed, curator |
| ⭐ Super-like | `approved` + `super_liked=true` | Strongest positive signal. Auto-syncs to Spotify playlist. |
| ❌ Reject | `rejected` | Negative signal. Audio file deleted. Artist/episode penalized. |
| → Skip | `skipped` | Weak negative. "Not now" — less penalizing than reject. |
| ⚠️ Bad source | `bad_source` | NOT a taste signal. Means wrong audio was downloaded. Filtered from queue until re-downloaded. |
| 👂 Listened | `listened` | Auto-set at 80% playback with no action. Treated as soft skip. |
| 🌿 Re-seed | creates new seed | Track becomes a new seed, feeding back into discovery. Irreversible. |

These are **mutually exclusive** (except re-seed which is independent). Changing vote is allowed.

Stored in `user_tracks` table (per-user). Global `tracks.status` also updated for approved/rejected/skipped.

## Engagement Tracking

In addition to explicit votes, the system tracks:
- `listen_pct` — what % of the track was heard (0-100)
- `listen_duration_ms` — total ms listened
- `action_delay_ms` — how fast the user acted after the track started

These feed into `tune-weights.ts` for weight adjustment.

## UI Indicators

### Track Card buttons
All mutually exclusive. When returning to a voted track, the voted button shows filled with vivid color + ring.

### Tracklist indicators
- 🌱 = seed (exact or artist match — no distinction in UI)
- 🌿 = re-seed
- Vote status: green heart (approved), gold star (super-liked), red X (rejected), amber arrow (skipped), orange triangle (bad source), gray (listened)

### Stats
- Per-seed: episodes found, tracks total, downloaded, enriched
- Algorithm dashboard: current weights, weight history, session breakdown, per-seed hit rates, approval trend

## Spotify Integration

- **Sync playlist**: "Azorean Stacks" — all approved tracks
- **Super-likes playlist**: "Azorean Super Likes" — only super-liked tracks
- Auto-syncs on approval

## Multi-user

Seeds are filtered by `user_id`. Each user only sees their own seeds, votes, and taste profile. The test account ([redacted]) is isolated from the main account (hi@aylan.io).

## Key Technical Details

- **Framework:** Next.js (App Router) + Bun
- **Database:** Supabase (Postgres + Auth + Storage + Realtime)
- **Hosting:** Vercel (client), Mac mini (engine)
- **Local dev:** `cd apps/client && bun run dev` → localhost:3004
- **Audio downloads:** yt-dlp → Supabase Storage → signed URLs
- **Test account:** [redacted] / [redacted]
- **Build before push:** Always run `npx next build` locally
- **Use `Array.from()` not `[...Set]`** (Vercel TS config issue)

## Open Questions

1. Should we unify the two scoring systems? (Probably yes)
2. Should real-time session adaptation stay? (Probably simplify — small dataset, caused many bugs)
3. How often should taste_score be recalculated? (After each voting session? Daily?)
4. Should we add audio feature analysis (BPM, energy) for better DJ-relevant ranking?
