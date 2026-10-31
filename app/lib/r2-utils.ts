export function isSafeKey(key: string, allowEmpty = false): boolean {
  if (allowEmpty && key === "") return true;
  if (!key || new TextEncoder().encode(key).byteLength > 1024) return false;
  if (key.startsWith("/") || key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key)) {
    return false;
  }
  return !key.split("/").some((part) => part === "." || part === "..");
}

export function contentTypeForKey(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    avif: "image/avif",
    css: "text/css; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    flac: "audio/flac",
    gif: "image/gif",
    heic: "image/heic",
    html: "text/html; charset=utf-8",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    m4a: "audio/mp4",
    markdown: "text/markdown; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xml: "application/xml; charset=utf-8",
    zip: "application/zip",
  };
  return types[extension] ?? "application/octet-stream";
}

export function safeInlineType(contentType: string): string | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (
    type.startsWith("image/") &&
    type !== "image/svg+xml" &&
    type !== "image/heic"
  ) {
    return contentType;
  }
  if (type.startsWith("audio/") || type.startsWith("video/")) return contentType;
  if (
    type === "application/pdf" ||
    type === "application/json" ||
    type === "text/plain" ||
    type === "text/markdown" ||
    type === "text/csv"
  ) {
    return contentType;
  }
  return null;
}

export function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
