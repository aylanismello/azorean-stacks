import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function getAuthenticatedUser(req: NextRequest) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only access to auth cookies in route handlers.
        },
      },
    }
  );

  return supabase.auth.getUser();
}

// PATCH /api/seeds/[id] — toggle active
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = getServiceClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(req);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if (typeof body.active === "boolean") {
    updates.active = body.active;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // Only allow updating seeds already owned by the current user. Legacy
  // unowned rows require an explicit administrative migration, not claiming
  // through a browser mutation.
  const { data: existing } = await supabase
    .from("seeds")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: "Seed not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("seeds")
    .update(updates)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// DELETE /api/seeds/[id]
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = getServiceClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(req);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Authorize before any mutation. Legacy NULL-owner seeds cannot be claimed
  // through this destructive route.
  const { data: seed, error: seedError } = await supabase
    .from("seeds")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (seedError) return NextResponse.json({ error: seedError.message }, { status: 500 });
  if (!seed) return NextResponse.json({ error: "Seed not found" }, { status: 404 });

  // The RPC keeps lineage cleanup atomic and deliberately leaves shared
  // catalog tracks, audio, votes, queue records, and ranking history intact.
  const { data: deleted, error } = await supabase.rpc("delete_owned_seed", {
    p_seed_id: params.id,
    p_user_id: user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!deleted) return NextResponse.json({ error: "Seed not found" }, { status: 404 });

  return NextResponse.json({ deleted: true });
}
