import { NextRequest, NextResponse } from "next/server";
// **The only two things this sub-app borrows from its host.** Swap these for
// whatever the next home provides — a session reader and a database client that
// bypasses row-level security — and every other file here is unchanged.
import { getServiceClient } from "@/lib/supabase";
import { getRequestUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

// The board is one person's. Middleware already turns away anyone without a
// session, and the table's RLS only answers to this address — but these routes
// run as the service role, which is precisely the key RLS cannot stop, so the
// check has to be made here too rather than assumed from either of them.
const OWNER = "hi@aylan.io";

const STATUSES = ["built", "verified"] as const;
type Status = (typeof STATUSES)[number];

async function owner(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.email?.toLowerCase() !== OWNER) {
    return { error: NextResponse.json({ error: "This board isn't yours" }, { status: 403 }) };
  }
  return { user };
}

// GET /api/lol — every card, newest area first; the page does the grouping.
export async function GET(req: NextRequest) {
  const gate = await owner(req);
  if (gate.error) return gate.error;

  const db = getServiceClient();
  const { data, error } = await db
    .from("lol_items")
    .select("*")
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

// POST /api/lol — a new thing to check.
export async function POST(req: NextRequest) {
  const gate = await owner(req);
  if (gate.error) return gate.error;

  const body = await req.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "Give the card a title" }, { status: 400 });
  if (title.length > 300) return NextResponse.json({ error: "That title is too long" }, { status: 400 });

  const db = getServiceClient();
  const { data, error } = await db
    .from("lol_items")
    .insert({
      title,
      detail: typeof body?.detail === "string" && body.detail.trim() ? body.detail.trim() : null,
      area: typeof body?.area === "string" && body.area.trim() ? body.area.trim() : "General",
      source: typeof body?.source === "string" && body.source.trim() ? body.source.trim() : null,
      // a new card lands at the bottom of its column
      sort: typeof body?.sort === "number" ? body.sort : 9999,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}

// PATCH /api/lol — move a card between columns, or write what you found.
// `verified_at` is not settable: a trigger derives it from `status`, so the
// stamp can never disagree with the column the card is sitting in.
export async function PATCH(req: NextRequest) {
  const gate = await owner(req);
  if (gate.error) return gate.error;

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "Which card?" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  // Where the card sits in its column. Dropping one rewrites the order of the
  // column it landed in, so this arrives on its own or alongside a status.
  if (typeof body?.sort === "number" && Number.isFinite(body.sort)) {
    patch.sort = Math.round(body.sort);
  }
  if (typeof body?.status === "string") {
    if (!STATUSES.includes(body.status as Status)) {
      return NextResponse.json({ error: "A card is either built or verified" }, { status: 400 });
    }
    patch.status = body.status;
  }
  for (const field of ["title", "detail", "area", "source", "notes"] as const) {
    if (typeof body?.[field] === "string") {
      const v = (body[field] as string).trim();
      patch[field] = v || (field === "title" || field === "area" ? undefined : null);
      if (patch[field] === undefined) {
        return NextResponse.json({ error: `${field} can't be empty` }, { status: 400 });
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data, error } = await db.from("lol_items").update(patch).eq("id", id).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}

// DELETE /api/lol?id=… — for a card that turned out to be nothing.
export async function DELETE(req: NextRequest) {
  const gate = await owner(req);
  if (gate.error) return gate.error;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Which card?" }, { status: 400 });

  const db = getServiceClient();
  const { error } = await db.from("lol_items").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
