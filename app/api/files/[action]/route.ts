import { bucketOrNull, failure, fileInfo, isReservedKey, objectResponse, pathToKey, relativePathToKey, success, type Bucket } from "../../../lib/puremania";
import { contentTypeForKey } from "../../../lib/r2-utils";
import { createZipResponse, extractZipToR2 } from "../../../lib/puremania-zip";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ action: string }> };

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}

async function deletePath(bucket: Bucket, key: string): Promise<void> {
  const exact = await bucket.head(key);
  if (exact) { await bucket.delete(key); return; }
  const prefix = key + "/";
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.filter((item) => !item.key.startsWith(".__puremania__/"));
    if (keys.length) await bucket.delete(keys.map((item) => item.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function movePath(bucket: Bucket, sourceKey: string, targetKey: string): Promise<void> {
  if (sourceKey === targetKey) return;
  if (await bucket.head(targetKey)) throw new Error("The destination already exists");
  const exact = await bucket.head(sourceKey);
  const sourcePrefix = sourceKey + "/";
  const objects = exact ? [{ key: sourceKey }] : (await (async () => {
    const found = [] as Array<{ key: string }>;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: sourcePrefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      found.push(...page.objects);
      if (found.length > 100000) throw new Error("The folder has too many objects to move at once");
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return found;
  })());
  if (!objects.length) throw new Error("Source file or folder not found");
  const destinationPrefix = targetKey + "/";
  for (const item of objects) {
    const oldKey = item.key;
    if (oldKey.startsWith(".__puremania__/")) throw new Error("Protected storage metadata cannot be moved");
    const newKey = exact ? targetKey : destinationPrefix + oldKey.slice(sourcePrefix.length);
    const source = await bucket.get(oldKey);
    if (!source) throw new Error("A source object disappeared while moving");
    await bucket.put(newKey, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata });
  }
  await bucket.delete(objects.map((item) => item.key));
}

function baseName(key: string) { return key.split("/").pop() || "file"; }
function validName(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 180 &&
    !value.includes("/") && !value.includes("\\") && !value.includes("..") && !/[\u0000-\u001f\u007f]/.test(value);
}

export async function GET(request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { action } = await context.params;
  const url = new URL(request.url);
  const key = pathToKey(url.searchParams.get("path"));
  if (!key) return failure("Invalid file path", 400);
  try {
    if (action === "download") return await objectResponse(request, bucket, key, false);
    if (action === "content") {
      const objectHead = await bucket.head(key);
      if (!objectHead) return failure("File not found", 404);
      const contentType = objectHead.httpMetadata?.contentType ?? contentTypeForKey(key);
      const extension = baseName(key).split(".").pop()?.toLowerCase() ?? "";
      const editable = contentType.startsWith("text/") || ["json", "xml", "yaml", "yml", "csv", "md", "markdown", "js", "ts", "jsx", "tsx", "go", "py", "rs", "java", "css", "html", "htm", "php", "sh", "sql", "toml"].includes(extension);
      if (!editable) return await objectResponse(request, bucket, key, true);
      if (objectHead.size > 11 * 1024 * 1024) return failure("File is too large for the text editor", 413);
      const object = await bucket.get(key);
      if (!object) return failure("File not found", 404);
      return success({ content: await object.text() });
    }
    if (action === "thumbnail") {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#17202d"/><rect x="270" y="135" width="100" height="72" rx="12" fill="#2c3949" stroke="#8293a8" stroke-width="4"/><path d="M308 154v34l30-17z" fill="#d5deea"/><text x="320" y="250" text-anchor="middle" fill="#d5deea" font-family="sans-serif" font-size="18">Video preview</text></svg>';
      return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Content-Security-Policy": "sandbox", "Cache-Control": "private, max-age=3600" } });
    }
    return failure("Unsupported file operation", 404);
  } catch {
    return failure("Could not read the selected R2 object", 500);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const bucket = bucketOrNull();
  if (!bucket) return failure("R2 bucket is not configured", 503);
  const { action } = await context.params;
  if (action === "upload") {
    try {
      const form = await request.formData();
      const file = form.get("file");
      const directory = pathToKey(form.get("path") || "/", true);
      if (!(file instanceof File) || directory === null) return failure("Invalid uploaded file", 400);
      if (file.size > 64 * 1024 * 1024) return failure("Use the resumable upload for files larger than 64 MiB", 413);
      const name = relativePathToKey(file.name);
      if (!name) return failure("Invalid file name", 400);
      const key = [directory, name].filter(Boolean).join("/");
      await bucket.put(key, file.stream(), { httpMetadata: { contentType: file.type || contentTypeForKey(key) } });
      return success({ path: "/" + key, size: file.size }, 201);
    } catch {
      return failure("Could not store the uploaded file", 500);
    }
  }
  const body = await readJson(request);
  if (!body) return failure("Invalid JSON", 400);
  try {
    if (action === "mkdir") {
      const parent = pathToKey(body.path ?? "/", true);
      if (parent === null || !validName(body.name)) return failure("Invalid directory name", 400);
      const name = String(body.name).trim();
      const folder = [parent, name].filter(Boolean).join("/");
      if (await bucket.head(folder)) return failure("A file or folder with that name already exists", 409);
      const existing = await bucket.list({ prefix: folder + "/", limit: 1 });
      if (existing.objects.length) return failure("A file or folder with that name already exists", 409);
      await bucket.put(folder + "/.keep", null, { httpMetadata: { contentType: "application/x-directory" }, customMetadata: { kind: "folder-marker" } });
      return success({ path: "/" + folder }, 201);
    }
    if (action === "create") {
      const parent = pathToKey(body.path ?? "/", true);
      if (parent === null || !validName(body.name)) return failure("Invalid file name", 400);
      let name = String(body.name).trim();
      if (!name.includes(".")) name += ".md";
      const key = [parent, name].filter(Boolean).join("/");
      if (!pathToKey("/" + key) || isReservedKey(key)) return failure("Invalid file path", 400);
      if (await bucket.head(key)) return failure("A file with that name already exists", 409);
      const content = typeof body.content === "string" ? body.content : "";
      await bucket.put(key, content, { httpMetadata: { contentType: contentTypeForKey(key) } });
      return success({ path: "/" + key }, 201);
    }
    if (action === "save") {
      const key = pathToKey(body.path);
      if (!key || typeof body.content !== "string") return failure("Invalid file content", 400);
      if (new TextEncoder().encode(body.content).byteLength > 11 * 1024 * 1024) return failure("Text file is too large", 413);
      await bucket.put(key, body.content, { httpMetadata: { contentType: contentTypeForKey(key) } });
      return success({ message: "File saved successfully" });
    }
    if (action === "delete") {
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (paths.length < 1 || paths.length > 1000 || !paths.every((item) => typeof item === "string" && pathToKey(item))) return failure("Invalid delete paths", 400);
      for (const item of paths as string[]) await deletePath(bucket, pathToKey(item)!);
      return success({ deleted: paths.length });
    }
    if (action === "move") {
      const source = pathToKey(body.sourcePath);
      const target = pathToKey(body.targetPath);
      if (!source || !target || isReservedKey(source) || isReservedKey(target)) return failure("Invalid source or destination path", 400);
      await movePath(bucket, source, target);
      return success({ path: "/" + target });
    }
    if (action === "extract") {
      const source = pathToKey(body.path);
      if (!source) return failure("Invalid archive path", 400);
      if (!source.toLowerCase().endsWith(".zip")) return failure("This object storage deployment currently extracts ZIP archives", 415);
      const output = source.slice(0, -4);
      if (await bucket.head(output)) return failure("The extraction folder already exists", 409);
      const outputPage = await bucket.list({ prefix: output + "/", limit: 1 });
      if (outputPage.objects.length) return failure("The extraction folder already exists", 409);
      let count: number;
      try {
        count = await extractZipToR2(bucket, source, output + "/");
      } catch (error) {
        await deletePath(bucket, output).catch(() => undefined);
        throw error;
      }
      return success({ path: "/" + output, extractedFiles: count });
    }
    if (action === "download-zip") {
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length || paths.length > 1000 || !paths.every((item) => typeof item === "string" && pathToKey(item))) return failure("Invalid archive paths", 400);
      const token = crypto.randomUUID();
      await bucket.put(".__puremania__/prepared-zips/" + token + ".json", JSON.stringify({ paths, createdAt: Date.now() }), { httpMetadata: { contentType: "application/json" } });
      return success({ downloadUrl: "/api/files/download-zip/" + token });
    }
    return failure("Unsupported file operation", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return failure(message.slice(0, 240), 500);
  }
}
