import { bucketOrNull, failure, readUploadSession, sessionObjectKey } from "../../../../lib/puremania";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { id } = await context.params;
  try {
    const session = await readUploadSession(bucket, id);
    if (!session) return failure("Upload session not found", 404);
    return Response.json({
      uploadId: session.id,
      uploadedBytes: session.uploadedBytes,
      totalBytes: session.totalBytes,
      completed: session.completed,
      fingerprint: session.fingerprint,
    });
  } catch {
    return failure("Could not read upload progress", 500);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { id } = await context.params;
  try {
    const session = await readUploadSession(bucket, id);
    if (!session) return new Response(null, { status: 204 });
    if (session.uploadId && !session.completed) {
      await bucket.resumeMultipartUpload(session.key, session.uploadId).abort().catch(() => undefined);
    }
    await bucket.delete(sessionObjectKey(id));
    return new Response(null, { status: 204 });
  } catch {
    return failure("Could not discard upload session", 500);
  }
}
