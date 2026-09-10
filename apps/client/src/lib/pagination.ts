export interface PaginationOptions {
  defaultLimit: number;
  maxLimit?: number;
}

function parseNonNegativeInteger(raw: string | null, fallback: number, name: string): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

export function parsePagination(
  searchParams: URLSearchParams,
  { defaultLimit, maxLimit = 100 }: PaginationOptions,
): { limit: number; offset: number } {
  const requestedLimit = parseNonNegativeInteger(searchParams.get("limit"), defaultLimit, "limit");
  const offset = parseNonNegativeInteger(searchParams.get("offset"), 0, "offset");
  if (requestedLimit < 1) throw new Error("limit must be at least 1");
  return { limit: Math.min(requestedLimit, maxLimit), offset };
}
