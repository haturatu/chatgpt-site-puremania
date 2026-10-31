import { env } from "cloudflare:workers";
import {
  contentTypeForKey,
  errorResponse,
  isSafeKey,
} from "../../lib/r2-utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const bucket = env.BUCKET;
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);

  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor") || undefined;
  const requestedLimit = Number(url.searchParams.get("limit") ?? 200);

  if (!isSafeKey(prefix, true)) {
    return errorResponse("無効な検索プレフィックスです。", 400);
  }

  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
    : 200;

  try {
    const page = await bucket.list({
      prefix,
      delimiter: "/",
      limit,
      ...(cursor ? { cursor } : {}),
    });
    const objects = page.objects
      .filter((object) => !object.key.endsWith("/") && !object.key.endsWith("/.keep"))
      .map((object) => ({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        etag: object.httpEtag,
        contentType: object.httpMetadata?.contentType ?? contentTypeForKey(object.key),
      }));

    return Response.json({
      objects,
      folders: page.delimitedPrefixes ?? [],
      cursor: page.truncated ? page.cursor : null,
      truncated: page.truncated,
    });
  } catch {
    return errorResponse("R2 の一覧を取得できませんでした。", 500);
  }
}

export async function POST(request: Request) {
  const bucket = env.BUCKET;
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);

  try {
    const body = (await request.json()) as { keys?: unknown };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (
      keys.length < 1 ||
      keys.length > 1000 ||
      !keys.every((key) => typeof key === "string" && isSafeKey(key))
    ) {
      return errorResponse("削除対象のキーが無効です。", 400);
    }
    await bucket.delete(keys as string[]);
    return Response.json({ deleted: keys.length });
  } catch {
    return errorResponse("オブジェクトを削除できませんでした。", 500);
  }
}
