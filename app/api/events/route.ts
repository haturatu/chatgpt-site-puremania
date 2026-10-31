import { bucketOrNull, failure } from "../../lib/puremania";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!bucketOrNull()) return failure("R2 bucket is not configured", 503);
  const body = "retry: 30000\nevent: sync\ndata: {}\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
