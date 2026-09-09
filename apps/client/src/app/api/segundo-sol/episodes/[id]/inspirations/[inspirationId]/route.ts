import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: { id: string; inspirationId: string } };

export async function DELETE(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await getServiceClient()
    .from("segundo_sol_inspirations")
    .delete()
    .eq("id", params.inspirationId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Inspiration not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
