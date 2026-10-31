import { bucketOrNull, failure, success } from "../../lib/puremania";

export const dynamic = "force-dynamic";

export async function GET() {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  try { await bucket.list({ limit: 1 }); return success({ status: "ok" }); }
  catch { return failure("R2 storage is unavailable", 503); }
}
