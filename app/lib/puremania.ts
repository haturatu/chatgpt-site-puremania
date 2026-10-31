import { env } from "cloudflare:workers";
import { contentTypeForKey, isSafeKey, safeInlineType } from "./r2-utils";

export const INTERNAL_PREFIX = ".__puremania__/";
export const UPLOAD_SESSION_PREFIX = INTERNAL_PREFIX + "upload-sessions/";
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const UPLOAD_CONCURRENCY_CAPACITY = 32;

export type Bucket = R2Bucket;
export type FileInfo = {
  name: string;
  path: string;
  size: number;
  mod_time: string;
  is_dir: boolean;
  mime_type: string;
  is_editable: boolean;
  is_mount: boolean;
};
export type SavedPart = { partNumber: number; etag: string; size: number };
export type UploadSession = {
  id: string;
  uploadId: string;
  key: string;
  path: string;
  relativePath: string;
  totalBytes: number;
  uploadedBytes: number;
  fingerprint: string;
  parts: SavedPart[];
  completed: boolean;
  createdAt: number;
  updatedAt: number;
};

export function bucketOrNull(): Bucket | null {
  return env.BUCKET ?? null;
}

export function success(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  return Response.json({ success: true, data }, { status, headers: responseHeaders });
}

export function failure(message: string, status = 400, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json({ success: false, message }, { status, headers: responseHeaders });
}

export function pathToKey(value: unknown, allowRoot = false): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  const key = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!key && allowRoot) return "";
  if (!isSafeKey(key) || isReservedKey(key)) return null;
  return key;
}

export function relativePathToKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!isSafeKey(normalized) || isReservedKey(normalized)) return null;
  return normalized;
}

export function isReservedKey(key: string): boolean {
  return key === ".__puremania__" || key.startsWith(INTERNAL_PREFIX);
}

export function sessionObjectKey(id: string): string {
  return UPLOAD_SESSION_PREFIX + id + ".json";
}

export async function readUploadSession(bucket: Bucket, id: string): Promise<UploadSession | null> {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return null;
  const object = await bucket.get(sessionObjectKey(id));
  if (!object) return null;
  try {
    return (await object.json()) as UploadSession;
  } catch {
    return null;
  }
}

export async function writeUploadSession(bucket: Bucket, session: UploadSession): Promise<void> {
  await bucket.put(sessionObjectKey(session.id), JSON.stringify(session), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { kind: "puremania-upload-session" },
  });
}

export function fileInfo(key: string, size: number, uploaded: Date, isDir = false): FileInfo {
  const name = key.replace(/\/$/, "").split("/").pop() ?? key;
  const mime = isDir ? "application/octet-stream" : contentTypeForKey(key);
  const editableExtensions = new Set([
    "txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv", "tsv", "log",
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "html", "htm", "css", "scss", "xml",
    "go", "py", "rs", "java", "c", "h", "cpp", "hpp", "php", "sh", "sql",
  ]);
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const isEditable = !isDir && (mime.startsWith("text/") || ["application/json", "application/xml"].includes(mime.split(";")[0]) || editableExtensions.has(extension));
  return {
    name,
    path: "/" + key.replace(/\/$/, ""),
    size: isDir ? 0 : size,
    mod_time: uploaded.toISOString(),
    is_dir: isDir,
    mime_type: mime,
    is_editable: isEditable,
    is_mount: false,
  };
}

export function encodeCursor(value: { c: string | null; o: number; p: string | null; pp?: string | null }): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeCursor(value: string): { c: string | null; o: number; p: string | null; pp: string | null } {
  if (!value) return { c: null, o: 0, p: null, pp: null };
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { c?: unknown; o?: unknown; p?: unknown; pp?: unknown };
    return {
      c: typeof parsed.c === "string" ? parsed.c : null,
      o: Number.isFinite(parsed.o) ? Math.max(0, Math.trunc(parsed.o as number)) : 0,
      p: typeof parsed.p === "string" ? parsed.p : null,
      pp: typeof parsed.pp === "string" ? parsed.pp : null,
    };
  } catch {
    return { c: null, o: 0, p: null, pp: null };
  }
}

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size < 1) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1, start, end };
}

export async function objectResponse(request: Request, bucket: Bucket, key: string, inline = false): Promise<Response> {
  if (!isSafeKey(key) || isReservedKey(key)) return failure("Invalid path", 400);
  const rangeHeader = request.headers.get("range");
  const head = rangeHeader ? await bucket.head(key) : null;
  if (rangeHeader && !head) return failure("File not found", 404);
  const partial = rangeHeader && head ? parseRange(rangeHeader, head.size) : null;
  if (rangeHeader && !partial) {
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + (head?.size ?? 0) } });
  }
  const object = await bucket.get(key, partial ? { range: { offset: partial.offset, length: partial.length } } : undefined);
  if (!object) return failure("File not found", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = object.httpMetadata?.contentType ?? contentTypeForKey(key);
  const safeInline = inline
    ? (contentType.split(";")[0].trim().toLowerCase() === "image/svg+xml" ? contentType : safeInlineType(contentType))
    : null;
  const name = key.split("/").pop() || "download";
  const encodedName = encodeURIComponent(name).replace(/['()]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", (safeInline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodedName);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  if (contentType.split(";")[0].toLowerCase() === "image/svg+xml") headers.set("Content-Security-Policy", "sandbox");
  if (partial && head) {
    headers.set("Content-Length", String(partial.length));
    headers.set("Content-Range", "bytes " + partial.start + "-" + partial.end + "/" + head.size);
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

export async function listAllKeys(bucket: Bucket, prefix: string, max = 100000): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects.filter((item) => !item.key.startsWith(INTERNAL_PREFIX)));
    if (objects.length > max) throw new Error("Too many objects for this operation");
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
