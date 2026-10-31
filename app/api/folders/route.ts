import { env } from "cloudflare:workers";
import { errorResponse, isSafeKey } from "../../lib/r2-utils";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const bucket = env.BUCKET;
  if (!bucket) return errorResponse("R2 バケットが設定されていません。", 503);

  try {
    const body = (await request.json()) as { prefix?: string; name?: string };
    const prefix = body.prefix ?? "";
    const name = body.name?.trim() ?? "";
    if (
      !isSafeKey(prefix, true) ||
      !name ||
      name.length > 180 ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      name === "." ||
      name === ".."
    ) {
      return errorResponse("フォルダー名が無効です。", 400);
    }

    const marker = prefix + name + "/.keep";
    if (!isSafeKey(marker)) return errorResponse("フォルダー名が無効です。", 400);
    const existing = await bucket.head(marker);
    if (existing) return errorResponse("同じ名前のフォルダーがあります。", 409);

    await bucket.put(marker, null, {
      httpMetadata: { contentType: "application/x-directory" },
      customMetadata: { kind: "folder-marker" },
    });
    return Response.json({ prefix: prefix + name + "/" }, { status: 201 });
  } catch {
    return errorResponse("フォルダーを作成できませんでした。", 500);
  }
}
