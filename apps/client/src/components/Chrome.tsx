"use client";

import { usePathname } from "next/navigation";
import { Navigation } from "@/components/Navigation";
import { GlobalPlayer } from "@/components/GlobalPlayer";

/**
 * **The app's furniture, and the routes that do without it.**
 *
 * Nearly every page here is a room in one house and wants the same front door:
 * the nav across the top, the player along the bottom. `/lol` is not — it is a
 * board you stand in front of and work through, its own small application that
 * happens to live at this domain and share its sign-in. Wearing the nav, it read
 * as a page *of* the Stacks that had been styled wrong; without it, it is simply
 * the thing it is.
 *
 * The providers stay either way — the board still needs to know who you are, and
 * the theme still has to follow you into it. It is the furniture that goes, not
 * the foundations.
 *
 * Prefix-matched, so anything under `/lol` inherits the same bareness rather
 * than a child route quietly growing a nav its parent does not have.
 */
const BARE = ["/lol"];

export function Chrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const bare = BARE.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (bare) return <main className="min-h-dvh">{children}</main>;

  return (
    <>
      <Navigation />
      <main className="pb-0 md:pb-20">{children}</main>
      <GlobalPlayer />
    </>
  );
}
