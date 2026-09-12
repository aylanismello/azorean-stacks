# Complete the unfinished 4U experience

## Request ledger

| Item | Current state | Completion contract |
|---|---|---|
| CLAP sonic map | Not started | Local segment embeddings, versioned vector storage, user-scoped nearest neighbors, clusters/labels, bounded ranking component, seed/feedback steering, incremental worker and verified production sample |
| Seed tangent | Backend-only queue mutation | One durable seed-derived tangent object identifying seed, affected tracks, queue positions, additions/moves/retirements; ordinary maintenance stays silent; inspectable client notice/history |
| Why this track | Raw diagnostics | Plain-language primary reason naming concrete seed/show/context/sonic evidence; numerical diagnostics secondary and explicitly relative |
| Taste tuning | Existing static model, legacy tuner unused | Analyze actual user-scoped labeled queue history, fit bounded weights, persist model, apply it in scoring, compare baseline vs tuned and queue changes |
| ±30 controls | Rejected text pills | 44px non-pill circular seek SVGs with direction animation, accessible labels and reduced-motion behavior; no clipping at tested widths |
| Connection status | Healthy phone icon visible | No healthy indicator; phone-only actionable recovering/stalled state |
| Missing artwork | One-time repair | Paginated recurring source recovery plus canonical appearance fallback; worker schedule, tests and production readback |

## Product contracts

### Tangent

- Trigger: a completed, explicit user-owned seed/re-seed refresh only.
- State: durable user-scoped record keyed by seed refresh generation.
- Playback: current track never changes.
- Queue: at most three affected tracks enter or move immediately after the protected first five; existing relative order is preserved elsewhere.
- Copy: literal seed, track count, queue positions and any retirement count. Never call routine ranking/readiness changes a branch or tangent.
- Inspection: View expands the exact affected tracks. Affected cards identify their seed.

### Why this track

1. Lead with the strongest concrete evidence in one sentence.
2. Prefer explicit tangent/seed lineage, then sonic seed similarity, show/source-context outcome, curator affinity, episode yield, co-occurrence, artist and genre.
3. Keep raw relative score and weighted contributions in an expandable diagnostics section only.

### CLAP

- Analyze three deterministic 20-second mono segments per track.
- Normalize segment vectors, average, and normalize the track vector.
- Store no audio in the database; keep model/version/hash/segment metadata with a 512-d vector.
- Build user sonic preference from active seeds and positive/negative decisions. Use cosine similarity as a capped 0.10 ranking component.
- Sonic neighbors may join only an already user-eligible candidate pool and never bypass active-seed/listen/opinion exclusions.
- Incrementally embed newly stored audio; failures remain retryable and the recommender degrades safely when embeddings are absent.

## Delivery order

1. Add migrations for tangents, CLAP vectors/RPCs, and real ranking-model weights.
2. Add tested pure libraries for tangent summaries, natural explanations, seek animation contracts, CLAP aggregation and empirical weight fitting.
3. Integrate engine tangent recording, CLAP indexing/retrieval/scoring, recurring artwork recovery and model tuning.
4. Integrate API payloads and client tangent/Why/player UI.
5. Apply migrations to verified Azorean project; run empirical tune and a bounded CLAP production backfill.
6. Run full client/engine tests, typechecks, build, shell checks, runtime worker verification, authenticated browser QA and independent review.
7. Commit/push main, verify remote SHA, CI/deployment, production API/UI/database/worker, then close the ledger.
