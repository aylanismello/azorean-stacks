import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { canEditSharedCatalog, getRequestUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const user = await getRequestUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!canEditSharedCatalog(user)) {
      return NextResponse.json({ error: "Engine commands require catalog-editor access" }, { status: 403 });
    }

    const supabase = getServiceClient();
    const { type, payload } = await request.json();

    const episodeId = payload?.episode_id;
    if (type !== "enrich_episode" || typeof episodeId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(episodeId)) {
      return NextResponse.json({ error: "Invalid command" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("commands")
      .insert({ type, payload: { episode_id: episodeId } })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error("Error creating command:", error);
    return NextResponse.json({ error: "Failed to create command" }, { status: 500 });
  }
}
