import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

type Context = { params: Promise<{ slug: string }> };

async function context(req: NextRequest, props: Context) {
  const user = await getRequestUser(req);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { slug } = await props.params;
  const db = getServiceClient();
  const { data: series, error } = await db.from("mix_series").select("id,slug").eq("slug", slug).maybeSingle();
  if (error) return { response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!series) return { response: NextResponse.json({ error: "Series not found" }, { status: 404 }) };
  return { db, user, series };
}

export async function POST(req: NextRequest, props: Context) {
  const resolved = await context(req, props);
  if ("response" in resolved) return resolved.response;
  const { error } = await resolved.db.from("user_series_seeds").upsert({
    user_id: resolved.user.id, series_id: resolved.series.id,
  }, { onConflict: "user_id,series_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ seeded: true });
}

export async function DELETE(req: NextRequest, props: Context) {
  const resolved = await context(req, props);
  if ("response" in resolved) return resolved.response;
  const { error } = await resolved.db.from("user_series_seeds").delete()
    .eq("user_id", resolved.user.id).eq("series_id", resolved.series.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ seeded: false });
}
