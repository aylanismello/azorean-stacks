import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; jobId: string }> };

export async function GET(req: NextRequest, props: Context) {
  const params = await props.params;
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await getServiceClient()
    .from("segundo_sol_import_jobs")
    .select("*")
    .eq("id", params.jobId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Import not found" }, { status: 404 });
  return NextResponse.json({ job: data });
}
