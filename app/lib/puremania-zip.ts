import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipPassThrough } from "fflate";
import type { Bucket } from "./puremania";
import { contentTypeForKey, isSafeKey } from "./r2-utils";
import { listAllKeys, pathToKey } from "./puremania";

type ArchiveEntry = { key: string; name: string };

async function resolveEntries(bucket: Bucket, paths: string[]): Promise<ArchiveEntry[]> {
  const selected = new Map<string, string>();
  for (const path of paths) {
    const key = pathToKey(path);
    if (!key) throw new Error("Invalid path in archive request");
    const object = await bucket.head(key);
    if (object) {
      selected.set(key, key.split("/").pop() || "file");
      continue;
    }
    const prefix = key + "/";
    const children = await listAllKeys(bucket, prefix, 10000);
    const folderName = key.split("/").pop() || "folder";
    for (const child of children) {
      if (child.key.endsWith("/.keep")) continue;
      const relative = child.key.slice(prefix.length);
      selected.set(child.key, folderName + "/" + relative);
    }
  }
  if (selected.size > 10000) throw new Error("An archive can contain up to 10,000 files");
  return [...selected.entries()].map(([key, name]) => ({ key, name }));
}

export async function createZipResponse(bucket: Bucket, paths: string[]): Promise<Response> {
  const entries = await resolveEntries(bucket, paths);
  if (!entries.length) throw new Error("There are no files to download");
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((error, data, final) => {
        if (cancelled) return;
        if (error) { controller.error(error); return; }
        if (data?.byteLength) controller.enqueue(data);
        if (final) controller.close();
      });
      void (async () => {
        for (const entry of entries) {
          if (cancelled) return;
          const object = await bucket.get(entry.key);
          if (!object) throw new Error("A selected file was removed before the archive started");
          const file = new ZipPassThrough(entry.name);
          zip.add(file);
          currentReader = object.body.getReader();
          while (!cancelled) {
            const chunk = await currentReader.read();
            if (chunk.done) break;
            file.push(chunk.value);
          }
          currentReader.releaseLock();
          currentReader = null;
          if (cancelled) return;
          file.push(new Uint8Array(0), true);
        }
        if (!cancelled) zip.end();
      })().catch((error) => { if (!cancelled) controller.error(error); });
    },
    async cancel() {
      cancelled = true;
      await currentReader?.cancel().catch(() => undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename*=UTF-8''pure-mania-download.zip",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeArchiveName(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  const isDirectory = normalized.endsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/") + (isDirectory ? "/" : "");
}

export async function extractZipToR2(bucket: Bucket, sourceKey: string, outputPrefix: string): Promise<number> {
  const object = await bucket.get(sourceKey);
  if (!object) throw new Error("Archive not found");
  if (object.size > 2 * 1024 * 1024 * 1024) throw new Error("ZIP files larger than 2 GiB cannot be extracted here");
  const reader = object.body.getReader();
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  const uploads: Promise<unknown>[] = [];
  const activeWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  let outputBytes = 0;
  let fileCount = 0;
  let pendingWrites = Promise.resolve();
  let extractionError: Error | null = null;

  unzip.onfile = (file) => {
    const relative = safeArchiveName(file.name);
    if (!relative) { extractionError = new Error("Unsafe path in ZIP archive"); file.terminate(); return; }
    if (relative.endsWith("/")) return;
    fileCount += 1;
    if (fileCount > 5000) { extractionError = new Error("ZIP archive contains more than 5,000 files"); file.terminate(); return; }
    if (file.originalSize !== undefined && file.originalSize > 250 * 1024 * 1024) {
      extractionError = new Error("A ZIP entry exceeds the 250 MiB extraction limit"); file.terminate(); return;
    }
    const key = outputPrefix + relative;
    if (!isSafeKey(key)) { extractionError = new Error("Unsafe path in ZIP archive"); file.terminate(); return; }
    let fileBytes = 0;
    const channel = new TransformStream<Uint8Array, Uint8Array>();
    const writer = channel.writable.getWriter();
    activeWriters.add(writer);
    uploads.push(bucket.put(key, channel.readable, { httpMetadata: { contentType: contentTypeForKey(key) } }));
    file.ondata = (error, chunk, final) => {
      if (error) { extractionError = error; pendingWrites = pendingWrites.then(() => writer.abort(error)).catch(() => undefined); return; }
      fileBytes += chunk.byteLength;
      outputBytes += chunk.byteLength;
      if (fileBytes > 250 * 1024 * 1024 || outputBytes > 500 * 1024 * 1024) {
        extractionError = new Error("ZIP extraction exceeded its size limit");
        pendingWrites = pendingWrites.then(() => writer.abort(extractionError!)).catch(() => undefined);
        return;
      }
      pendingWrites = pendingWrites.then(() => writer.write(chunk));
      if (final) pendingWrites = pendingWrites.then(() => writer.close()).then(() => { activeWriters.delete(writer); });
      pendingWrites = pendingWrites.catch((reason) => { extractionError = reason instanceof Error ? reason : new Error("Could not write extracted file"); });
    };
    try { file.start(); } catch (error) { extractionError = error instanceof Error ? error : new Error("Unsupported ZIP compression"); }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      unzip.push(chunk.value, false);
      await pendingWrites;
      if (extractionError) throw extractionError;
    }
    unzip.push(new Uint8Array(0), true);
    await pendingWrites;
    await Promise.all(uploads);
    if (extractionError) throw extractionError;
    return fileCount;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    for (const writer of activeWriters) await writer.abort(error).catch(() => undefined);
    await pendingWrites.catch(() => undefined);
    await Promise.allSettled(uploads);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
