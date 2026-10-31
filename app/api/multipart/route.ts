import { env } from "cloudflare:workers";
import { errorResponse, isSafeKey } from "../../lib/r2-utils";

export const dynamic = "force-dynamic";

function params(request: Request) {
  const url = new URL(request.url);
  return {
    action: url.searchParams.get("action") ?? "",
    key: url.searchParams.get("key") ?? "",
    uploadId: url.searchParams.get("uploadId") ?? "",
  };
}

export async function POST(request: Request) {
  const bucket = env.BUCKET;
  const { action, key, uploadId } = params(request);
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (!isSafeKey(key)) return errorResponse("無効なオブジェクトキーです。", 400);

  try {
    if (action === "create") {
      const body = (await request.json()) as { contentType?: string };
      const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: {
          contentType: body.contentType?.slice(0, 255) || "application/octet-stream",
        },
      });
      return Response.json({ key: upload.key, uploadId: upload.uploadId });
    }
    if (action === "complete") {
      if (!uploadId) return errorResponse("uploadId が必要です。", 400);
      const body = (await request.json()) as {
        parts?: Array<{ partNumber?: number; etag?: string }>;
      };
      const parts = body.parts ?? [];
      if (
        parts.length < 1 ||
        parts.length > 10000 ||
        parts.some(
          (part) =>
            !Number.isInteger(part.partNumber) ||
            (part.partNumber ?? 0) < 1 ||
            !part.etag ||
            typeof part.etag !== "string",
        )
      ) {
        return errorResponse("アップロード済みパーツの情報が無効です。", 400);
      }
      const ordered = [...parts]
        .map((part) => ({ partNumber: part.partNumber!, etag: part.etag! }))
        .sort((a, b) => a.partNumber - b.partNumber);
      if (new Set(ordered.map((part) => part.partNumber)).size !== ordered.length) {
        return errorResponse("パーツ番号が重複しています。", 400);
      }
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      const object = await upload.complete(ordered);
      return Response.json({
        key,
        size: object.size,
        etag: object.httpEtag,
        uploaded: object.uploaded.toISOString(),
      });
    }
    return errorResponse("この操作はサポートされていません。", 400);
  } catch {
    return errorResponse("分割アップロードを開始または完了できませんでした。", 500);
  }
}

export async function PUT(request: Request) {
  const bucket = env.BUCKET;
  const { action, key, uploadId } = params(request);
  const partNumber = Number(new URL(request.url).searchParams.get("partNumber"));
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (!isSafeKey(key) || !uploadId) return errorResponse("アップロード情報が無効です。", 400);
  if (action !== "part" || !request.body || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return errorResponse("パーツの情報が無効です。", 400);
  }

  try {
    const upload = bucket.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return Response.json(part);
  } catch {
    return errorResponse("アップロードパーツを保存できませんでした。", 500);
  }
}

export async function DELETE(request: Request) {
  const bucket = env.BUCKET;
  const { action, key, uploadId } = params(request);
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);
  if (action !== "abort" || !isSafeKey(key) || !uploadId) {
    return errorResponse("アップロード情報が無効です。", 400);
  }

  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
    return new Response(null, { status: 204 });
  } catch {
    return errorResponse("分割アップロードを中止できませんでした。", 500);
  }
}
