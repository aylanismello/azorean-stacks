import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";

export async function getRequestUser(req: NextRequest) {
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {},
      },
    }
  );

  const {
    data: { user },
  } = await auth.auth.getUser();

  return user;
}

type CatalogEditorUser = {
  id: string;
  app_metadata?: Record<string, unknown> | null;
};

export function canEditSharedCatalog(
  user: CatalogEditorUser | string,
  rawEditorIds = process.env.AZOREAN_CATALOG_EDITOR_IDS || "",
): boolean {
  const userId = typeof user === "string" ? user : user.id;
  const hasCatalogEditorCapability =
    typeof user === "object" && user.app_metadata?.catalog_editor === true;

  return hasCatalogEditorCapability || rawEditorIds
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}
