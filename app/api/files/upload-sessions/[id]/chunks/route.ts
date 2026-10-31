import { bucketOrNull, failure, readUploadSession, success, UPLOAD_CHUNK_SIZE, UPLOAD_CONCURRENCY_CAPACITY, writeUploadSession } from "../../../../../lib/puremania";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { id } = await context.params;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers.get("content-range") ?? "");
  if (!match || !request.body) return failure("A valid Content-Range and request body are required", 400);
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  const length = end - start + 1;
  if (![start, end, total, length].every(Number.isSafeInteger) || start < 0 || end < start || length < 1 || length > UPLOAD_CHUNK_SIZE) {
    return failure("Invalid upload chunk range", 400);
  }

  try {
    const session = await readUploadSession(bucket, id);
    if (!session || session.completed || !session.uploadId) return failure("Upload session not found", 404);
    if (total !== session.totalBytes || start !== session.uploadedBytes || start % UPLOAD_CHUNK_SIZE !== 0 || end >= total) {
      return failure("Upload chunk does not match the saved file position", 409);
    }
    const partNumber = Math.floor(start / UPLOAD_CHUNK_SIZE) + 1;
    if (partNumber > 10000) return failure("This R2 upload exceeds the 10,000-part limit", 413);
    const part = await bucket.resumeMultipartUpload(session.key, session.uploadId).uploadPart(partNumber, request.body);
    session.parts = session.parts.filter((saved) => saved.partNumber !== partNumber);
    session.parts.push({ partNumber, etag: part.etag, size: length });
    session.parts.sort((a, b) => a.partNumber - b.partNumber);
    session.uploadedBytes = Math.max(session.uploadedBytes, end + 1);
    session.updatedAt = Date.now();
    await writeUploadSession(bucket, session);
    return Response.json({ uploadedBytes: session.uploadedBytes }, {
      headers: { "Upload-Concurrency-Capacity": String(UPLOAD_CONCURRENCY_CAPACITY) },
    });
  } catch {
    return failure("Could not store this upload chunk in R2", 500);
  }
}
