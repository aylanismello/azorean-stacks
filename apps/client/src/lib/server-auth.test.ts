import { describe, expect, test } from "bun:test";
import { canEditSharedCatalog } from "./server-auth";

describe("canEditSharedCatalog", () => {
  test("accepts the deployment allowlist", () => {
    expect(canEditSharedCatalog({ id: "editor" }, "editor,other")).toBe(true);
  });

  test("accepts an explicit server-owned app metadata capability", () => {
    expect(canEditSharedCatalog({
      id: "editor",
      app_metadata: { catalog_editor: true },
    }, "")).toBe(true);
  });

  test("does not trust unrelated metadata or accounts", () => {
    expect(canEditSharedCatalog({
      id: "listener",
      app_metadata: { role: "catalog_editor" },
    }, "editor")).toBe(false);
  });
});