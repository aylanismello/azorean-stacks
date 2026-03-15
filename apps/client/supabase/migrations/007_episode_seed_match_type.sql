-- Track whether the episode was found via full seed match (artist+title in tracklist)
-- or just an artist-only fallback from NTS search results
alter table episode_seeds add column match_type text not null default 'unknown';
-- 'full'    = seed artist+title found in the episode tracklist
-- 'artist'  = only the artist appeared, title not confirmed
-- 'unknown' = legacy rows before we tracked this
