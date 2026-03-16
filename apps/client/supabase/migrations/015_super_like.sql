-- ============================================================================
-- Migration 015: Super Like
-- ============================================================================
-- Adds super_liked boolean to user_tracks so users can mark a track
-- as a "super like" — triggering local download via the engine watcher.
-- ============================================================================

alter table user_tracks
add column if not exists super_liked boolean not null default false;

create index if not exists idx_user_tracks_super_liked
  on user_tracks(super_liked)
  where super_liked = true;
