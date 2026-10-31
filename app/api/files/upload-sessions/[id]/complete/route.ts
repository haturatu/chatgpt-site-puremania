import { bucketOrNull, failure, readUploadSession, writeUploadSession } from "../../../../../lib/puremania";
import { contentTypeForKey } from "../../../../../lib/r2-utils";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { id } = await context.params;
  try {
    const session = await readUploadSession(bucket, id);
    if (!session) return failure("Upload session not found", 404);
    if (session.completed) return Response.json({ success: true, path: "/" + session.key });
    if (session.uploadedBytes !== session.totalBytes) return failure("The whole file has not been uploaded", 409);
    if (session.totalBytes === 0) {
      await bucket.put(session.key, new Uint8Array(0), { httpMetadata: { contentType: contentTypeForKey(session.key) } });
    } else {
      const parts = session.parts.map(({ partNumber, etag }) => ({ partNumber, etag })).sort((a, b) => a.partNumber - b.partNumber);
      if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1)) return failure("Some upload chunks are missing", 409);
      const result = await bucket.resumeMultipartUpload(session.key, session.uploadId).complete(parts);
      if (result.size !== session.totalBytes) return failure("R2 completed a file with an unexpected size", 500);
    }
    session.completed = true;
    session.updatedAt = Date.now();
    await writeUploadSession(bucket, session);
    return Response.json({ success: true, path: "/" + session.key, uploadedBytes: session.totalBytes });
  } catch {
    return failure("Could not finish the R2 multipart upload", 500);
  }
}
