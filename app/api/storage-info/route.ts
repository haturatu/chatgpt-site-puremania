import { bucketOrNull, failure, success } from "../../lib/puremania";

export const dynamic = "force-dynamic";

export async function GET() {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  // R2 bindings do not expose account-level quota totals; keep the API shape
  // while the UI labels the quota as object storage instead of inventing one.
  return success({ total: 0, free: 0, used: 0, usage_percent: 0 });
}
