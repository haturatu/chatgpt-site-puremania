import { bucketOrNull, failure, success, UPLOAD_CHUNK_SIZE, UPLOAD_CONCURRENCY_CAPACITY } from "../../lib/puremania";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!bucketOrNull()) return failure("R2 bucket is not configured", 503);
  return success({
    StorageDir: "R2 object storage",
    MountDirs: [],
    SpecificDirs: [],
    MaxFileSize: UPLOAD_CHUNK_SIZE * 10000,
    UploadConcurrencyCapacity: UPLOAD_CONCURRENCY_CAPACITY,
    Aria2cEnabled: false,
  });
}
