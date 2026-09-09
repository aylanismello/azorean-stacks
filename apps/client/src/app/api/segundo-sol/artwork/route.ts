import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const runtime = "nodejs";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Artwork file is required" }, { status: 400 });
  }

  const extension = MIME_EXTENSIONS[file.type];
  if (!extension) {
    return NextResponse.json({ error: "Artwork must be JPEG, PNG, WebP, or GIF" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "Artwork must be smaller than 10 MB" }, { status: 400 });
  }

  const path = `${user.id}/${randomUUID()}.${extension}`;
  const db = getServiceClient();
  const { error } = await db.storage
    .from("segundo-sol-artwork")
    .upload(path, Buffer.from(await file.arrayBuffer()), {
      contentType: file.type,
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { data } = db.storage.from("segundo-sol-artwork").getPublicUrl(path);
  return NextResponse.json({ artwork_url: data.publicUrl, storage_path: path }, { status: 201 });
}
