import { bucketOrNull, failure, pathToKey, relativePathToKey, writeUploadSession, type UploadSession } from "../../../lib/puremania";
import { contentTypeForKey } from "../../../lib/r2-utils";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  let body: { path?: unknown; relativePath?: unknown; size?: unknown; fingerprint?: unknown };
  try { body = await request.json() as typeof body; } catch { return failure("Invalid JSON", 400); }
  const base = pathToKey(body.path ?? "/", true);
  const relative = relativePathToKey(body.relativePath);
  const size = Number(body.size);
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.slice(0, 256) : "";
  if (base === null || relative === null || !Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 ** 4 || !fingerprint) {
    return failure("Invalid upload information", 400);
  }
  const key = [base, relative].filter(Boolean).join("/");
  if (!key || key.length > 1024) return failure("Invalid destination path", 400);

  try {
    const id = crypto.randomUUID();
    const uploadId = size > 0
      ? (await bucket.createMultipartUpload(key, { httpMetadata: { contentType: contentTypeForKey(key) } })).uploadId
      : "";
    const session: UploadSession = {
      id, uploadId, key, path: typeof body.path === "string" ? body.path : "/", relativePath: relative,
      totalBytes: size, uploadedBytes: 0, fingerprint, parts: [], completed: false,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await writeUploadSession(bucket, session);
    return Response.json({ uploadId: id, uploadURL: "/api/files/upload-sessions/" + id, uploadedBytes: 0 });
  } catch {
    return failure("Could not create a resumable R2 upload", 500);
  }
}
