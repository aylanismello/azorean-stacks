# /lol — the verification board

Its own small application. It shares a domain and a sign-in with the Stacks and
**nothing else**: no nav, no player, no theme tokens, no shared components. That
is on purpose — this folder is meant to be lifted into its own repo without
unpicking anything.

## What it is

Two columns. **Built** is a claim somebody made. **Verified** is Aylan having
watched the thing work on his own device. Only a person moves a card across;
nothing here ever promotes itself, which is the entire argument of the tool.

## What is in here

| file | what |
|---|---|
| `types.ts` | the `Item` row and the two columns |
| `look.ts` | every colour, the list width, the label palette, the Pacific timestamp — no host tokens |
| `api.ts` | every network call the board makes |
| `server.ts` | the route handlers, exported for whatever router is hosting them |
| `Board.tsx` | the board: columns, drag and drop, state |
| `Card.tsx` | one card |
| `CardModal.tsx` | a card opened |
| `AddCard.tsx` | the composer at the foot of a list |

## What it borrows from the host

Three things, all replaceable in one file each:

1. **The route** — `app/lol/page.tsx` re-exports `Board`.
2. **The API route** — `app/api/lol/route.ts` re-exports from `server.ts`.
3. **Auth + database** — `server.ts` imports `getRequestUser` and
   `getServiceClient`. Swap those two imports and it runs anywhere.

The host's `Chrome` component keeps its nav and player off these routes.

## The table

`public.lol_items`, migration `047_lol_verification_board.sql`. `status` is
`built | verified` and nothing else; `verified_at` is derived by a trigger from
`status`, so the stamp can never disagree with the column the card sits in. RLS
answers to one email address.

## The rule

**Nothing but a person moves a card to `verified`.** Not a passing test, not a
screenshot, not a confident agent. That column exists to hold precisely what
confidence does not cover.
