# BACKLOG.md — Azorean Stacks

Items discovered during development. Check off when done. Add new items as you find them.

## Priority: High
- [ ] Bump batch refill trigger from 3 → 5 remaining tracks (more buffer for slow networks)
- [ ] Full user isolation refactor: stop writing votes to `tracks.status` entirely (decision #7 in SOURCE_OF_TRUTH.md) — currently bandaided
- [ ] Episode mode playback: investigate if audio stops on mobile Safari/Brave (WebKit) when navigating between tabs

## Priority: Medium
- [ ] `/api/stacks/[id]/queue` is now redundant for playback (replaced by `/api/fyp?seed_id=X`) — can be removed once stacks overview page is updated
- [ ] `/api/tracks?status=pending` path is now mostly unused for FYP — clean up dead code paths
- [ ] Add audio feature analysis (BPM, energy, key) to taste scoring for DJ-relevant ranking
- [ ] Engine: auto-mark tracks as bad_source after 3 failed download attempts
- [ ] Stats page counts should come from `user_tracks` consistently (some may still read `tracks.status`)

## Priority: Low
- [ ] Lot Radio and other sources beyond NTS
- [ ] Multi-user collaborative filtering (if other DJs join)
- [ ] Playlist-aware scoring (DJ set flow — what tracks pair well together)
- [ ] DB view for seed stats instead of paginated junction table queries

## Completed (move items here with date)
- [x] 2026-03-20: Unified `/api/fyp` endpoint with Postgres RPC (PR #135)
- [x] 2026-03-20: Full pagination sweep — all `.in()` queries (PR #121)
- [x] 2026-03-20: User isolation — votes in user_tracks only (PR #124)
- [x] 2026-03-20: Unified scoring algorithm (PR #116)
- [x] 2026-03-20: Player owns all state refactor (PR #115)
- [x] 2026-03-20: Fix bad_source constraint + proper storage (PR #125, #126)
- [x] 2026-03-20: Fix bad source modal with inline re-download (PR #127, #132)
- [x] 2026-03-20: Spotify playlist ordering (PR #117)
- [x] 2026-03-20: Stacks card display consistency (PR #121)
