import { bucketOrNull, failure, success } from "../../lib/puremania";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!bucketOrNull()) return failure("R2 bucket is not configured", 503);
  return success([]);
}
