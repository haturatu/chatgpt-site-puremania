import { bucketOrNull, failure } from "../../../../lib/puremania";
import { createZipResponse } from "../../../../lib/puremania-zip";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ token: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) return failure("Invalid download token", 400);
  const key = ".__puremania__/prepared-zips/" + token + ".json";
  try {
    const saved = await bucket.get(key);
    if (!saved) return failure("Prepared download has expired", 404);
    const record = await saved.json() as { paths?: unknown; createdAt?: unknown };
    await bucket.delete(key);
    if (!Array.isArray(record.paths) || Date.now() - Number(record.createdAt) > 60 * 60 * 1000) return failure("Prepared download has expired", 410);
    return await createZipResponse(bucket, record.paths.filter((path): path is string => typeof path === "string"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not prepare the archive";
    return failure(message.slice(0, 240), 500);
  }
}
