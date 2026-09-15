/**
 * The route, and nothing but the route — the board itself is its own small
 * application under `src/lol`, which shares this domain and its sign-in and
 * borrows nothing else. See `src/lol/README.md`.
 */
export { Board as default } from "@/lol/Board";
