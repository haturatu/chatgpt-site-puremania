import {
  bucketOrNull,
  decodeCursor,
  encodeCursor,
  failure,
  fileInfo,
  INTERNAL_PREFIX,
  pathToKey,
  success,
} from "../../lib/puremania";

export const dynamic = "force-dynamic";

function sortFiles<T extends { name: string; is_dir: boolean; size: number; mod_time: string; mime_type: string }>(
  files: T[],
  field: string,
  direction: string,
) {
  const sign = direction === "desc" ? -1 : 1;
  return files.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let left: string | number = a.name.toLocaleLowerCase();
    let right: string | number = b.name.toLocaleLowerCase();
    if (field === "size") { left = a.size; right = b.size; }
    if (field === "modified") { left = Date.parse(a.mod_time) || 0; right = Date.parse(b.mod_time) || 0; }
    if (field === "type") { left = a.mime_type; right = b.mime_type; }
    return (left < right ? -1 : left > right ? 1 : 0) * sign;
  });
}

export async function GET(request: Request) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const url = new URL(request.url);
  const virtualPath = url.searchParams.get("path") || "/";
  const key = pathToKey(virtualPath, true);
  if (key === null) return failure("Invalid directory path", 400);
  const prefix = key ? key + "/" : "";
  const requestedLimit = Number(url.searchParams.get("limit") || 0);
  const paged = Number.isFinite(requestedLimit) && requestedLimit > 0;
  const limit = paged ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 500;
  const rawCursor = url.searchParams.get("cursor") || "";
  const cursorState = decodeCursor(rawCursor);
  let r2Cursor = cursorState.c || undefined;

  try {
    // Numeric cursors remain accepted for bookmarks created by the original UI.
    if (/^\d+$/.test(rawCursor) && Number(rawCursor) > 0) {
      let remaining = Math.min(Number(rawCursor), 100000);
      while (remaining > 0) {
        const skipped = await bucket.list({ prefix, delimiter: "/", limit: Math.min(1000, remaining), ...(r2Cursor ? { cursor: r2Cursor } : {}) });
        remaining -= skipped.objects.length + (skipped.delimitedPrefixes?.length ?? 0);
        if (!skipped.truncated) { r2Cursor = undefined; break; }
        r2Cursor = skipped.cursor;
      }
    }

    const page = await bucket.list({
      prefix,
      delimiter: "/",
      limit,
      ...(r2Cursor ? { cursor: r2Cursor } : {}),
    });
    const files = page.objects
      .filter((object) => object.key !== INTERNAL_PREFIX && !object.key.startsWith(INTERNAL_PREFIX) && !object.key.endsWith("/.keep") && !object.key.endsWith("/"))
      .map((object) => fileInfo(object.key, object.size, object.uploaded));
    for (const directory of page.delimitedPrefixes ?? []) {
      if (directory.startsWith(INTERNAL_PREFIX)) continue;
      const name = directory.slice(prefix.length).replace(/\/$/, "");
      if (!name || name === ".__puremania__") continue;
      files.push(fileInfo(directory, 0, new Date(0), true));
    }
    sortFiles(files, url.searchParams.get("sort") || "name", url.searchParams.get("direction") || "asc");

    const etagSource = files.map((item) => [item.path, item.size, item.mod_time].join(":")).join("|") + (page.cursor || "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(etagSource));
    const etag = '"' + Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("") + '"';
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });

    if (!paged) return success(files, 200, { ETag: etag });
    const offset = /^\d+$/.test(rawCursor) ? Number(rawCursor) : cursorState.o;
    const nextCursor = page.truncated
      ? encodeCursor({ c: page.cursor, o: offset + files.length, p: cursorState.c, pp: cursorState.p })
      : "";
    const prevCursor = offset > 0
      ? encodeCursor({ c: cursorState.p, o: Math.max(0, offset - limit), p: cursorState.pp, pp: null })
      : "";
    return success({
      data: files,
      offset,
      limit,
      total: null,
      nextCursor,
      prevCursor,
      hasMore: page.truncated,
    }, 200, { ETag: etag });
  } catch {
    return failure("Could not list objects from R2", 500);
  }
}
