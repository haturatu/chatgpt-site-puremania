import { bucketOrNull, decodeCursor, encodeCursor, failure, fileInfo, INTERNAL_PREFIX, pathToKey, success } from "../../lib/puremania";

export const dynamic = "force-dynamic";
const MAX_SCAN_PAGES = 50;

function encodeSearchCursor(cursor: string, after: string | null) {
  return "@" + encodeCursor({ c: cursor || null, o: 0, p: after });
}

export async function POST(request: Request) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  let body: { term?: unknown; path?: unknown; useRegex?: unknown; caseSensitive?: unknown; scope?: unknown; cursor?: unknown; limit?: unknown };
  try { body = await request.json() as typeof body; } catch { return failure("Invalid JSON", 400); }
  const term = typeof body.term === "string" ? body.term : "";
  const path = pathToKey(body.path ?? "/", true);
  const scope = body.scope === "recursive" ? "recursive" : "current";
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit)
    ? Math.min(Math.max(Math.trunc(body.limit), 1), 500)
    : 100;
  if (!term || term.length > 300 || path === null) return failure("Invalid search request", 400);
  let matcher: RegExp;
  try { matcher = new RegExp(body.useRegex === true ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), body.caseSensitive === true ? "" : "i"); }
  catch { return failure("Invalid regular expression", 400); }

  const prefix = path ? path + "/" : "";
  let cursor = "";
  let after: string | null = null;
  const suppliedCursor = typeof body.cursor === "string" ? body.cursor : "";
  if (suppliedCursor.startsWith("@")) {
    const state = decodeCursor(suppliedCursor.slice(1));
    cursor = state.c || "";
    after = state.p;
  } else if (suppliedCursor) {
    after = suppliedCursor.replace(/^\/+/, "");
  }

  try {
    const results = [] as ReturnType<typeof fileInfo>[];
    let hasMore = false;
    let nextCursor = "";
    for (let scan = 0; scan < MAX_SCAN_PAGES; scan++) {
      const page = await bucket.list({
        prefix,
        ...(scope === "current" ? { delimiter: "/" } : {}),
        limit: 1000,
        ...(cursor ? { cursor } : after ? { startAfter: after } : {}),
      });
      const candidates = page.objects
        .filter((object) => !object.key.startsWith(INTERNAL_PREFIX) && !object.key.endsWith("/.keep"))
        .map((object) => fileInfo(object.key, object.size, object.uploaded));
      for (const folder of page.delimitedPrefixes ?? []) {
        if (folder.startsWith(INTERNAL_PREFIX)) continue;
        candidates.push(fileInfo(folder, 0, new Date(0), true));
      }
      candidates.sort((a, b) => a.path.localeCompare(b.path));
      for (const candidate of candidates) {
        const key = candidate.path.slice(1);
        if (after && key <= after) continue;
        if (!matcher.test(candidate.name)) continue;
        results.push(candidate);
        if (results.length > limit) break;
      }
      if (results.length > limit) {
        results.pop();
        hasMore = true;
        nextCursor = results.at(-1)?.path || "";
        break;
      }
      if (!page.truncated) break;
      cursor = page.cursor;
      after = null;
      if (scan === MAX_SCAN_PAGES - 1) {
        hasMore = true;
        nextCursor = encodeSearchCursor(cursor, null);
      }
    }
    return success({ data: results, nextCursor: hasMore ? nextCursor : "", hasMore });
  } catch {
    return failure("Search could not finish scanning the R2 bucket", 500);
  }
}
