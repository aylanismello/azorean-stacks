# HOW TO MAEK SHIT BETER

What's been done in this pass + what should come next.

---

## What was fixed / improved

### Bugs squashed
- **GlobalPlayer double-seek**: progress bar had both `onClick` and `onMouseDown` causing seek to fire twice on click. Removed redundant handler and increased hit area from `h-3` to `h-5` for better mobile usability.
- **SpotifyProvider stale closure**: `loadSDK` captured stale `accessToken` in the `onSpotifyWebPlaybackSDKReady` callback. SDK would fire before the token state updated, causing silent failures. Fixed with `useRef` to always read current token.
- **GlobalPlayerProvider duplicate logic**: `loadTrack` had the same spotify check twice (`if spotify... else if audio... else if spotify...`). Collapsed into single check.
- **AuthProvider re-creating supabase client**: `createClient()` was called on every render. Wrapped in `useMemo`.
- **Supabase service client re-created per request**: Cached the service role client in a module-level variable.
- **Signed URL generation sequential (slow)**: Tracks API was `await`-ing each signed URL one at a time. Now generates all in parallel with `Promise.all`.
- **Pre-existing TypeScript build error**: `episodes/[id]/route.ts` failed to compile because Supabase client had no generated types. Fixed by typing the client as `SupabaseClient<any>` since there are no generated DB types.
- **Dead imports in TrackCard**: `PlayerSection` and `AudioPlayerHandle` were imported but unused. `audioState` and `playerRef` were declared but never used. Removed.

### Mobile improvements
- **Touch swipe gestures on TrackCard**: Can now physically swipe cards left/right with visual feedback (KEEP/SKIP badges, rotation, opacity). Threshold = 80px.
- **Bigger touch targets on Approved page**: Mobile icon buttons bumped from `p-1.5` / 14px icons to `p-2` / 16px icons with `rounded-lg`.
- **Body scroll lock on mobile bottom sheet**: Navigation's account menu now locks `document.body.style.overflow` when open.
- **iOS input zoom prevention**: Added `maximumScale: 1, userScalable: false` to viewport config.
- **Tap highlight removed**: Added `-webkit-tap-highlight-color: transparent` and `overscroll-behavior-y: contain` to body.
- **StackBrowser episode rows restructured**: Changed from cramped single-line rows to two-line layout (title + action on top, metadata badges below) — much more usable on 375px screens.
- **Episode page action buttons**: Made `flex-wrap` friendly and added `active:scale-95` for tactile feedback.

---

## What should come next (ranked by impact)

### 1. Generate Supabase types
The entire codebase is untyped against the database. Every `.from("table")` call returns `any`. Run `supabase gen types typescript` and wire it into the client. This is the single highest-leverage thing to do — it'll catch bugs at build time instead of runtime.

### 2. Add optimistic UI to the swipe flow
Right now, `handleVote` fires a network request and the card exit animation waits for the response. On slow connections this feels broken. The vote should be optimistic — animate immediately, queue the API call, and only roll back on failure.

### 3. Pull-to-refresh on the Stack page
Mobile users have no way to refresh without the browser's pull-to-refresh (which reloads the whole page). A lightweight pull-to-refresh on the main swipe page would feel native.

### 4. Service Worker + offline queue
If you lose signal mid-swipe, votes are silently lost. A service worker could queue votes offline and replay them when connectivity returns. This matters because the app is used for music discovery which often happens on the go.

### 5. Skeleton loading states
Every page shows a spinner. Skeleton screens (shimmer placeholders matching the layout) feel significantly faster and prevent layout shift. Priority: Stack page card skeleton, Approved page row skeletons.

### 6. Batch the tracks ingest API
The POST `/api/tracks` endpoint inserts tracks one-by-one with individual dedup checks. This should be a single batch upsert. For large episode crawls (30+ tracks), this would be dramatically faster.

### 7. Error boundaries per section
A crash in the GlobalPlayer currently takes down the whole app. Add React error boundaries around: GlobalPlayer, TrackCard, StackBrowser, and each page. Let crashes be contained.

### 8. Swipe gesture improvements
- Add haptic feedback (`navigator.vibrate`) on threshold cross
- Rubberband effect when swiping past threshold
- Velocity-based triggering (fast flick = vote regardless of distance)

### 9. Preload next track's audio
When viewing track N, start preloading track N+1's audio in the background. This eliminates the loading delay when advancing cards.

### 10. Add `<link rel="preconnect">` for external domains
The app loads from Supabase storage, Spotify CDN, NTS media, etc. Preconnecting to these origins in the `<head>` would shave 100-200ms off first resource loads.

### 11. Move API auth to middleware
API routes are all public right now (the middleware skips `/api/*`). The vote/seed endpoints should validate the user's session server-side. Right now any unauthenticated request can vote on tracks.

### 12. Add keyboard shortcut for play/pause
Space bar should toggle play/pause in the global player (when not focused on an input). Currently only arrow keys and j/k are bound.

### 13. PWA manifest
Add a `manifest.json` with app name, icons, theme color, and `"display": "standalone"`. This lets users install the app to their home screen and get a native-feeling experience.

### 14. Virtualize the Approved page list
With hundreds of approved tracks, rendering them all causes jank. Use `react-window` or similar to virtualize the list and only render visible rows.

### 15. Add undo on vote
After swiping, show a brief toast with "Undo" that lets the user reverse their last vote. Prevents the "oh shit I meant to keep that" moment.
