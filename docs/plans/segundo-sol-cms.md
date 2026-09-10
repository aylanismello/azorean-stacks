# Segundo Sol Sessions

## Product boundary

A private, authenticated workspace inside Azorean Stacks at `/segundo-sol`.

- **Stacks** supplies the user's kept and super-liked catalog.
- **Segundo Sol** supplies episode identity, theme, artwork, sequencing, notes, and inspiration mixes.
- **PicoDrops** remains the downstream high-quality file/materialization workflow; CMS rows retain enough source provenance to hand selected tracks off cleanly later.

## V1 data model

1. `segundo_sol_episodes`: per-user episode drafts with number, title, theme, status, notes, artwork.
2. `segundo_sol_episode_tracks`: ordered track snapshots; optional link to a shared Stacks `tracks` row; source origin/type/URL and metadata remain attached even if the catalog changes.
3. `segundo_sol_inspirations`: ordered references to mixes/playlists with enriched title, creator, artwork, platform, and URL.
4. `segundo-sol-artwork` storage bucket: public artwork objects written only through authenticated server API paths namespaced by user ID.

Every table uses RLS and explicit user ownership. Episode children validate ownership both through foreign keys/RLS and the server API.

## API

- `GET|POST /api/segundo-sol/episodes`
- `GET|PATCH|DELETE /api/segundo-sol/episodes/:id`
- `GET /api/segundo-sol/library?kind=all|super_liked|approved&search=`
- `POST /api/segundo-sol/enrich`
- `POST /api/segundo-sol/artwork`
- `POST /api/segundo-sol/episodes/:id/tracks`
- `PATCH|DELETE /api/segundo-sol/episodes/:id/tracks/:trackId`
- `POST /api/segundo-sol/episodes/:id/inspirations`
- `DELETE /api/segundo-sol/episodes/:id/inspirations/:inspirationId`

## Frontend

- `☀☀` desktop navigation tab and mobile More-sheet entry.
- Episode rail with create/select/delete and status/track-count summaries.
- Selected episode editor with autosaved core fields and artwork upload.
- Track builder with two sources: Stacks library and pasted music URL.
- Ordered tracklist with editable artist/title/role/notes, move controls, source links, and remove.
- Inspiration area for pasted mixes/playlists with metadata cards.
- Warm Segundo Sol art direction layered on the existing dark/light tokens.

## Verification

- Unit tests for platform classification, oEmbed/HTML metadata normalization, and dedupe keys.
- Migration validation in a rollback transaction, then production apply and schema readback.
- Client TypeScript, focused Bun tests, production build, authenticated desktop/mobile browser flow.
- Push reviewed changes to `main`; verify GitHub/Vercel deployment and production route.
