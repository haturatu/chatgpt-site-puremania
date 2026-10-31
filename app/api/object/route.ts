import { env } from "cloudflare:workers";
import {
  contentTypeForKey,
  errorResponse,
  isSafeKey,
  safeInlineType,
} from "../../lib/r2-utils";

export const dynamic = "force-dynamic";

function getKey(request: Request): string {
  return new URL(request.url).searchParams.get("key") ?? "";
}

function rangeFor(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size < 1) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1, start, end };
}

function disposition(key: string, inline: boolean, contentType: string): string {
  const safeType = inline ? safeInlineType(contentType) : null;
  const mode = safeType ? "inline" : "attachment";
  const name = key.split("/").pop() || "download";
  const encoded = encodeURIComponent(name).replace(/['()]/g, (char) =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return mode + "; filename*=UTF-8''" + encoded;
}

export async function GET(request: Request) {
  const bucket = env.BUCKET;
  const key = getKey(request);
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (!isSafeKey(key)) return errorResponse("無効なオブジェクトキーです。", 400);

  try {
    const rangeHeader = request.headers.get("range");
    const head = rangeHeader || request.method === "HEAD" ? await bucket.head(key) : null;
    if (head === null && request.method === "HEAD") return new Response(null, { status: 404 });
    if (head === null && rangeHeader) return errorResponse("オブジェクトが見つかりません。", 404);

    const partial = rangeHeader && head ? rangeFor(rangeHeader, head.size) : null;
    if (rangeHeader && !partial) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + (head?.size ?? 0) },
      });
    }

    const object = await bucket.get(
      key,
      partial ? { range: { offset: partial.offset, length: partial.length } } : undefined,
    );
    if (!object) return errorResponse("オブジェクトが見つかりません。", 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const contentType = object.httpMetadata?.contentType ?? contentTypeForKey(key);
    headers.set("Content-Type", contentType);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "private, no-store");
    headers.set(
      "Content-Disposition",
      disposition(key, new URL(request.url).searchParams.get("inline") === "1", contentType),
    );

    if (partial) {
      headers.set("Content-Length", String(partial.length));
      headers.set(
        "Content-Range",
        "bytes " + partial.start + "-" + partial.end + "/" + head!.size,
      );
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
  } catch {
    return errorResponse("オブジェクトを読み込めませんでした。", 500);
  }
}

export async function HEAD(request: Request) {
  const bucket = env.BUCKET;
  const key = getKey(request);
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (!isSafeKey(key)) return errorResponse("無効なオブジェクトキーです。", 400);

  try {
    const object = await bucket.head(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(null, { headers });
  } catch {
    return errorResponse("オブジェクトの情報を取得できませんでした。", 500);
  }
}

export async function PUT(request: Request) {
  const bucket = env.BUCKET;
  const key = getKey(request);
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (!isSafeKey(key)) return errorResponse("無効なオブジェクトキーです。", 400);
  if (!request.body) return errorResponse("アップロード内容が空です。", 400);

  const contentType =
    request.headers.get("content-type")?.slice(0, 255) || contentTypeForKey(key);
  try {
    const object = await bucket.put(key, request.body, {
      httpMetadata: { contentType },
    });
    return Response.json(
      { key, size: object.size, uploaded: object.uploaded.toISOString() },
      { status: 201 },
    );
  } catch {
    return errorResponse("アップロードに失敗しました。大きなファイルは分割アップロードを利用してください。", 500);
  }
}

export async function POST(request: Request) {
  const bucket = env.BUCKET;
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);

  try {
    const body = (await request.json()) as { key?: string; newKey?: string };
    const oldKey = body.key ?? "";
    const newKey = body.newKey ?? "";
    if (!isSafeKey(oldKey) || !isSafeKey(newKey)) {
      return errorResponse("無効なオブジェクトキーです。", 400);
    }
    if (oldKey === newKey) return Response.json({ key: newKey });
    const existing = await bucket.head(newKey);
    if (existing) return errorResponse("同じ名前のオブジェクトがすでにあります。", 409);

    const source = await bucket.get(oldKey);
    if (!source) return errorResponse("移動元のオブジェクトが見つかりません。", 404);
    const copy = await bucket.put(newKey, source.body, {
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    });
    await bucket.delete(oldKey);
    return Response.json({ key: newKey, size: copy.size });
  } catch {
    return errorResponse("オブジェクト名を変更できませんでした。", 500);
  }
}

export async function DELETE(request: Request) {
  const bucket = env.BUCKET;
  const key = getKey(request);
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (!isSafeKey(key)) return errorResponse("無効なオブジェクトキーです。", 400);

  try {
    await bucket.delete(key);
    return new Response(null, { status: 204 });
  } catch {
    return errorResponse("オブジェクトを削除できませんでした。", 500);
  }
}
