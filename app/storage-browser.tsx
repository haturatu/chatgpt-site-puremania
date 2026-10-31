"use client";

import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Cloud,
  File,
  FileArchive,
  FileText,
  Film,
  Folder,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  LayoutGrid,
  List,
  LoaderCircle,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";

type StorageObject = {
  key: string;
  size: number;
  uploaded: string;
  etag: string;
  contentType: string;
};

type UploadItem = {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error" | "cancelled" | "skipped";
  detail?: string;
};

type UploadedPart = { partNumber: number; etag: string };

const PAGE_SIZE = 200;
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const BASE_PART_SIZE = 32 * 1024 * 1024;

function objectUrl(key: string, inline = false) {
  return (
    "/api/object?key=" +
    encodeURIComponent(key) +
    (inline ? "&inline=1" : "")
  );
}

function basename(key: string) {
  return key.split("/").filter(Boolean).pop() ?? key;
}

function extension(key: string) {
  const name = basename(key);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function typeForObject(object: StorageObject) {
  const type = object.contentType.toLowerCase();
  if (type !== "application/octet-stream") return type;
  const ext = extension(object.key);
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (["png", "gif", "webp", "avif"].includes(ext)) return "image/" + ext;
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video/" + ext;
  if (["mp3", "m4a", "ogg", "flac", "wav"].includes(ext)) return "audio/" + ext;
  if (["txt", "md", "csv", "json", "xml", "log"].includes(ext)) return "text/plain";
  if (ext === "pdf") return "application/pdf";
  return type;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return value.toLocaleString("ja-JP", {
    maximumFractionDigits: index === 0 ? 0 : 1,
  }) + " " + units[index];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function FileGlyph({ object }: { object: StorageObject }) {
  const type = typeForObject(object);
  const className = "h-[18px] w-[18px]";
  if (type.startsWith("image/")) return <ImageIcon className={className} />;
  if (type.startsWith("video/")) return <Film className={className} />;
  if (type.startsWith("audio/")) return <Music2 className={className} />;
  if (type.includes("zip") || type.includes("archive")) return <FileArchive className={className} />;
  if (type.startsWith("text/") || type.includes("json")) return <FileText className={className} />;
  return <File className={className} />;
}

function apiErrorMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, "リクエストに失敗しました。"));
  }
  return payload as T;
}

function xhrUpload(
  url: string,
  method: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<{ etag?: string; partNumber?: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open(method, url);
    xhr.responseType = "text";
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", abort);
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((payload ?? {}) as { etag?: string; partNumber?: number });
      } else {
        reject(new Error(apiErrorMessage(payload, "アップロードに失敗しました (" + xhr.status + ")")));
      }
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("通信が切れました。もう一度お試しください。"));
    };
    xhr.onabort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    xhr.send(body);
  });
}

function IconButton({
  label,
  onClick,
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={
        "inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 " +
        className
      }
    >
      {children}
    </button>
  );
}

export default function StorageBrowser() {
  const [prefix, setPrefix] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchPrefix, setSearchPrefix] = useState("");
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<"name" | "size" | "recent">("name");
  const [preview, setPreview] = useState<StorageObject | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewTextLimited, setPreviewTextLimited] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setSelected(new Set());
    const params = new URLSearchParams({
      prefix: prefix + searchPrefix,
      limit: String(PAGE_SIZE),
    });
    requestJson<{
      objects: StorageObject[];
      folders: string[];
      cursor: string | null;
    }>("/api/objects?" + params.toString(), { signal: controller.signal })
      .then((page) => {
        setObjects(page.objects);
        setFolders(page.folders);
        setCursor(page.cursor);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "一覧を読み込めませんでした。");
        setObjects([]);
        setFolders([]);
        setCursor(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [prefix, searchPrefix, refreshToken]);

  useEffect(() => {
    if (!preview) {
      setPreviewText("");
      setPreviewTextLimited(false);
      return;
    }
    const type = typeForObject(preview);
    if (
      !type.startsWith("text/") &&
      type !== "application/json" &&
      type !== "application/xml"
    ) {
      setPreviewText("");
      return;
    }
    const controller = new AbortController();
    setPreviewText("読み込み中…");
    setPreviewTextLimited(preview.size > 256 * 1024);
    fetch(objectUrl(preview.key), {
      headers: { Range: "bytes=0-262143" },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("テキストを読み込めませんでした。");
        return response.text();
      })
      .then(setPreviewText)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setPreviewText(reason instanceof Error ? reason.message : "テキストを読み込めませんでした。");
      });
    return () => controller.abort();
  }, [preview]);

  const loadNext = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        prefix: prefix + searchPrefix,
        cursor,
        limit: String(PAGE_SIZE),
      });
      const page = await requestJson<{
        objects: StorageObject[];
        folders: string[];
        cursor: string | null;
      }>("/api/objects?" + params.toString());
      setObjects((current) => [...current, ...page.objects]);
      setFolders((current) => Array.from(new Set([...current, ...page.folders])));
      setCursor(page.cursor);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "続きを読み込めませんでした。");
    } finally {
      setLoadingMore(false);
    }
  };

  const folderPrefix = (path: string) => {
    setPrefix(path);
    setSearchInput("");
    setSearchPrefix("");
    setSelected(new Set());
  };

  const applySearch = () => {
    setSearchPrefix(searchInput.trim());
    setSelected(new Set());
  };

  const visibleObjects = useMemo(() => {
    const copy = [...objects];
    if (sort === "size") return copy.sort((a, b) => b.size - a.size);
    if (sort === "recent") return copy.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
    return copy.sort((a, b) => a.key.localeCompare(b.key, "ja"));
  }, [objects, sort]);

  const loadedBytes = visibleObjects.reduce((total, object) => total + object.size, 0);

  const setUploadState = (id: string, changes: Partial<UploadItem>) => {
    setUploads((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  };

  const uploadOne = async (
    file: File,
    id: string,
    controller: AbortController,
  ): Promise<"done" | "skipped"> => {
    const key = prefix + file.name;
    const existing = await fetch(objectUrl(key), { method: "HEAD", signal: controller.signal });
    if (existing.status !== 404 && !existing.ok) {
      throw new Error("保存先を確認できませんでした。");
    }
    if (existing.ok) {
      const overwrite = window.confirm(
        "「" + file.name + "」はすでにあります。上書きしますか？",
      );
      if (!overwrite) return "skipped";
    }

    if (file.size < MULTIPART_THRESHOLD) {
      await xhrUpload(
        objectUrl(key),
        "PUT",
        file,
        file.type || "application/octet-stream",
        (loaded) =>
          setUploadState(id, {
            progress: file.size ? Math.min(99, Math.round((loaded / file.size) * 100)) : 70,
          }),
        controller.signal,
      );
      return "done";
    }

    const createUrl =
      "/api/multipart?action=create&key=" + encodeURIComponent(key);
    const created = await requestJson<{ uploadId: string }>(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type || "application/octet-stream" }),
      signal: controller.signal,
    });
    const partSize = Math.max(
      BASE_PART_SIZE,
      Math.ceil(file.size / 10000 / (1024 * 1024)) * 1024 * 1024,
    );
    const count = Math.ceil(file.size / partSize);
    const parts: UploadedPart[] = new Array(count);
    const inFlight = [0, 0, 0];
    let nextPart = 0;
    let completedBytes = 0;
    const updateProgress = () => {
      const activeBytes = inFlight.reduce((sum, bytes) => sum + bytes, 0);
      const percent = Math.min(99, Math.round(((completedBytes + activeBytes) / file.size) * 100));
      setUploadState(id, { progress: percent });
    };

    try {
      await Promise.all(
        inFlight.map(async (_value, slot) => {
          while (nextPart < count) {
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            const index = nextPart++;
            const start = index * partSize;
            const chunk = file.slice(start, Math.min(start + partSize, file.size));
            const partUrl =
              "/api/multipart?action=part&key=" +
              encodeURIComponent(key) +
              "&uploadId=" +
              encodeURIComponent(created.uploadId) +
              "&partNumber=" +
              String(index + 1);
            let uploaded: { etag?: string; partNumber?: number } | null = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                uploaded = await xhrUpload(
                  partUrl,
                  "PUT",
                  chunk,
                  "application/octet-stream",
                  (loaded) => {
                    inFlight[slot] = loaded;
                    updateProgress();
                  },
                  controller.signal,
                );
                break;
              } catch (reason) {
                if (controller.signal.aborted || attempt === 2) throw reason;
                await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
              }
            }
            if (!uploaded?.etag) throw new Error("R2 からパーツの ETag が返りませんでした。");
            parts[index] = { partNumber: index + 1, etag: uploaded.etag };
            completedBytes += chunk.size;
            inFlight[slot] = 0;
            updateProgress();
          }
        }),
      );

      await requestJson("/api/multipart?action=complete&key=" +
        encodeURIComponent(key) +
        "&uploadId=" +
        encodeURIComponent(created.uploadId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
        signal: controller.signal,
      });
      return "done";
    } catch (reason) {
      await fetch(
        "/api/multipart?action=abort&key=" +
          encodeURIComponent(key) +
          "&uploadId=" +
          encodeURIComponent(created.uploadId),
        { method: "DELETE" },
      ).catch(() => undefined);
      throw reason;
    }
  };

  const beginUploads = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    for (const file of files) {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      setUploads((current) => [
        { id, name: file.name, progress: 0, status: "uploading" },
        ...current,
      ]);
      try {
        const result = await uploadOne(file, id, controller);
        setUploadState(id, {
          status: result === "done" ? "done" : "skipped",
          progress: result === "done" ? 100 : 0,
        });
        if (result === "done") refresh();
      } catch (reason) {
        const cancelled =
          reason instanceof DOMException && reason.name === "AbortError";
        setUploadState(id, {
          status: cancelled ? "cancelled" : "error",
          detail: cancelled
            ? "中止しました"
            : reason instanceof Error
              ? reason.message
              : "アップロードに失敗しました",
        });
      } finally {
        controllers.current.delete(id);
      }
    }
  };

  const createFolder = async () => {
    const name = window.prompt("新しいフォルダー名");
    if (!name?.trim()) return;
    try {
      await requestJson("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, name }),
      });
      notify("フォルダーを作成しました。");
      refresh();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "フォルダーを作成できませんでした。");
    }
  };

  const renameObject = async (object: StorageObject) => {
    const oldName = basename(object.key);
    const nextName = window.prompt("新しいファイル名", oldName);
    if (!nextName?.trim() || nextName.trim() === oldName) return;
    const newKey = prefix + nextName.trim();
    try {
      await requestJson("/api/object", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: object.key, newKey }),
      });
      notify("名前を変更しました。");
      setPreview(null);
      refresh();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "名前を変更できませんでした。");
    }
  };

  const deleteObjects = async (keys: string[]) => {
    if (!keys.length) return;
    if (!window.confirm(keys.length === 1 ? "このファイルを削除しますか？" : keys.length + " 件を削除しますか？")) {
      return;
    }
    try {
      await requestJson("/api/objects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      setSelected(new Set());
      setPreview(null);
      notify("削除しました。");
      refresh();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "削除できませんでした。");
    }
  };

  const toggleSelected = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      notify("オブジェクトキーをコピーしました。");
    } catch {
      notify("クリップボードにコピーできませんでした。");
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.getElementById("object-search")?.focus();
      } else if (!typing && event.key.toLowerCase() === "u") {
        fileInput.current?.click();
      } else if (!typing && event.key === "Backspace" && preview) {
        setPreview(null);
      } else if (!typing && event.key === "Backspace" && prefix) {
        const trimmed = prefix.replace(/\/$/, "");
        const parent = trimmed.slice(0, Math.max(0, trimmed.lastIndexOf("/") + 1));
        folderPrefix(parent);
      } else if (!typing && event.key === "Delete" && selected.size) {
        void deleteObjects(Array.from(selected));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefix, preview, selected]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void beginUploads(event.dataTransfer.files);
  };

  const previewType = preview ? typeForObject(preview) : "";
  const segments = prefix.split("/").filter(Boolean);
  const breadcrumbPrefixes = segments.map((_segment, index) =>
    segments.slice(0, index + 1).join("/") + "/",
  );

  return (
    <div
      className="min-h-screen bg-[#f5f6fa] text-slate-900"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[248px] flex-col border-r border-slate-200/80 bg-white px-5 py-6 lg:flex">
        <button
          className="mb-9 flex items-center gap-3 text-left"
          onClick={() => folderPrefix("")}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-indigo-600 text-white shadow-lg shadow-indigo-200">
            <HardDrive className="h-5 w-5" />
          </span>
          <span>
            <span className="block text-[15px] font-bold tracking-tight">Pure Mania</span>
            <span className="block text-[11px] font-medium text-slate-400">OBJECT STORAGE</span>
          </span>
        </button>

        <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
          Workspace
        </p>
        <button
          onClick={() => folderPrefix("")}
          className="flex items-center gap-3 rounded-xl bg-indigo-50 px-3 py-2.5 text-left text-sm font-semibold text-indigo-700"
        >
          <Folder className="h-[17px] w-[17px]" />
          Files
          <span className="ml-auto rounded-md bg-white px-2 py-0.5 text-[10px] font-bold text-indigo-600">
            R2
          </span>
        </button>

        <div className="mt-auto rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white p-4">
          <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
            <ShieldCheck className="h-[18px] w-[18px]" />
          </span>
          <p className="text-sm font-semibold">本人限定のストレージ</p>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">
            この Site は本人だけが開けます。ファイルは R2 に保存されます。
          </p>
          <div className="mt-4 flex items-center gap-2 text-[11px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Private access
          </div>
        </div>
      </aside>

      <main className="min-h-screen lg:ml-[248px]">
        <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
          <div className="mx-auto flex h-[72px] max-w-[1480px] items-center justify-between gap-4 px-4 sm:px-7 xl:px-10">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white lg:hidden">
                <HardDrive className="h-[18px] w-[18px]" />
              </div>
              <div className="hidden min-w-0 items-center gap-2 text-sm sm:flex">
                <button
                  onClick={() => folderPrefix("")}
                  className="shrink-0 font-semibold text-slate-500 transition hover:text-slate-900"
                >
                  Storage
                </button>
                {segments.map((segment, index) => (
                  <span key={breadcrumbPrefixes[index]} className="flex min-w-0 items-center gap-2">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                    <button
                      onClick={() => folderPrefix(breadcrumbPrefixes[index])}
                      className={
                        "max-w-32 truncate transition hover:text-indigo-600 " +
                        (index === segments.length - 1
                          ? "font-semibold text-slate-900"
                          : "text-slate-500")
                      }
                    >
                      {segment}
                    </button>
                  </span>
                ))}
              </div>
              <div className="min-w-0 sm:hidden">
                <p className="truncate text-sm font-semibold">{segments.at(-1) ?? "ファイル"}</p>
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Pure Mania</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => refresh()}
                title="更新"
                className="hidden h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 sm:flex"
              >
                <RefreshCw className={"h-4 w-4 " + (busy ? "animate-spin" : "")} />
              </button>
              <button
                onClick={() => void createFolder()}
                className="hidden h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 sm:inline-flex"
              >
                <FolderPlus className="h-4 w-4" />
                <span className="hidden xl:inline">新しいフォルダー</span>
                <span className="xl:hidden">フォルダー</span>
              </button>
              <button
                onClick={() => fileInput.current?.click()}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-indigo-600 px-3.5 text-sm font-semibold text-white shadow-md shadow-indigo-200 transition hover:bg-indigo-700"
              >
                <Upload className="h-4 w-4" />
                <span>アップロード</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void beginUploads(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1480px] px-4 pb-16 pt-7 sm:px-7 sm:pt-9 xl:px-10">
          <div className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-indigo-600">
                <Cloud className="h-3.5 w-3.5" />
                <span>Cloudflare R2</span>
                <span className="h-1 w-1 rounded-full bg-slate-300" />
                <span className="text-slate-400">Private bucket</span>
              </div>
              <h1 className="text-[26px] font-bold tracking-[-0.035em] text-slate-950 sm:text-[30px]">
                {searchPrefix ? "オブジェクト検索" : "ファイル"}
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
                R2 に保存したファイルを、フォルダー感覚で整理・プレビューできます。
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                R2 接続
              </span>
              <span className="hidden sm:inline">/</span>
              <span className="hidden max-w-56 truncate font-mono text-[11px] sm:inline" title={prefix}>
                {prefix || "root"}
              </span>
            </div>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4">
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_10px_rgb(15_23_42/3%)] sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-500">読み込み済みオブジェクト</p>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                  <File className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-[22px] font-bold tracking-tight text-slate-900">
                {visibleObjects.length.toLocaleString("ja-JP")}
                <span className="ml-1.5 text-xs font-medium text-slate-400">件</span>
              </p>
              <p className="mt-1 text-[11px] text-slate-400">現在の一覧に読み込んだ数</p>
            </div>
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_10px_rgb(15_23_42/3%)] sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-500">読み込み済みサイズ</p>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                  <HardDrive className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-[22px] font-bold tracking-tight text-slate-900">
                {formatBytes(loadedBytes)}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">合計容量ではなく、読み込み済み分</p>
            </div>
          </div>

          <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_3px_18px_rgb(15_23_42/4%)]">
            <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="relative w-full max-w-[440px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="object-search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applySearch();
                      if (event.key === "Escape") {
                        setSearchInput("");
                        setSearchPrefix("");
                      }
                    }}
                    placeholder="名前の先頭から検索"
                    className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-9 pr-20 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                  />
                  {searchInput && (
                    <button
                      onClick={() => {
                        setSearchInput("");
                        setSearchPrefix("");
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    >
                      消去
                    </button>
                  )}
                </div>
                <button
                  onClick={applySearch}
                  className="h-10 shrink-0 rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  検索
                </button>
                <button
                  onClick={() => void createFolder()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50 sm:hidden"
                  aria-label="フォルダーを作成"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <label className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="hidden sm:inline">並び替え</span>
                  <span className="relative">
                    <select
                      value={sort}
                      onChange={(event) => setSort(event.target.value as "name" | "size" | "recent")}
                      className="h-9 appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-xs font-semibold text-slate-700 outline-none focus:border-indigo-300"
                    >
                      <option value="name">名前</option>
                      <option value="size">サイズ</option>
                      <option value="recent">更新日時</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  </span>
                </label>
                <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                  <button
                    onClick={() => setView("list")}
                    aria-label="リスト表示"
                    className={"flex h-8 w-8 items-center justify-center rounded-md " + (view === "list" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400")}
                  >
                    <List className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setView("grid")}
                    aria-label="グリッド表示"
                    className={"flex h-8 w-8 items-center justify-center rounded-md " + (view === "grid" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400")}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {searchPrefix && (
              <div className="flex items-center justify-between border-b border-indigo-100 bg-indigo-50/70 px-4 py-2.5 text-xs sm:px-5">
                <span className="min-w-0 truncate text-indigo-800">
                  プレフィックス一致: <code className="font-semibold">{prefix + searchPrefix}</code>
                </span>
                <button
                  onClick={() => {
                    setSearchPrefix("");
                    setSearchInput("");
                  }}
                  className="ml-3 shrink-0 font-semibold text-indigo-700 hover:text-indigo-900"
                >
                  検索を解除
                </button>
              </div>
            )}

            {selected.size > 0 && (
              <div className="flex items-center justify-between border-b border-indigo-100 bg-indigo-50/60 px-4 py-2.5 sm:px-5">
                <p className="text-sm font-semibold text-indigo-800">
                  {selected.size} 件を選択中
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelected(new Set())}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-white"
                  >
                    選択解除
                  </button>
                  <button
                    onClick={() => void deleteObjects(Array.from(selected))}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    削除
                  </button>
                </div>
              </div>
            )}

            {error ? (
              <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <p className="font-semibold">一覧を表示できません</p>
                <p className="mt-1">{error}</p>
                <button onClick={() => refresh()} className="mt-3 font-semibold underline">
                  再読み込み
                </button>
              </div>
            ) : busy ? (
              <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 text-sm text-slate-400">
                <LoaderCircle className="h-6 w-6 animate-spin text-indigo-500" />
                R2 の一覧を読み込んでいます
              </div>
            ) : (
              <>
                {view === "list" ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] border-collapse">
                      <thead>
                        <tr className="h-10 border-b border-slate-100 bg-slate-50/60 text-left text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                          <th className="w-12 pl-5">
                            <span className="sr-only">選択</span>
                          </th>
                          <th className="font-semibold">名前</th>
                          <th className="w-32 font-semibold">サイズ</th>
                          <th className="w-48 font-semibold">更新日時</th>
                          <th className="w-28 pr-4 text-right font-semibold">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {folders.map((folder) => (
                          <tr
                            key={folder}
                            className="group h-[58px] cursor-pointer border-b border-slate-50 transition hover:bg-indigo-50/40"
                            onClick={() => folderPrefix(folder)}
                          >
                            <td className="pl-5">
                              <span className="block h-4 w-4" />
                            </td>
                            <td>
                              <button className="flex max-w-[480px] items-center gap-3 text-left">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-500">
                                  <Folder className="h-[18px] w-[18px]" />
                                </span>
                                <span className="truncate text-sm font-semibold text-slate-800">
                                  {basename(folder.replace(/\/$/, ""))}
                                </span>
                                <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
                              </button>
                            </td>
                            <td className="text-xs text-slate-400">—</td>
                            <td className="text-xs text-slate-400">フォルダー</td>
                            <td />
                          </tr>
                        ))}
                        {visibleObjects.map((object) => (
                          <tr
                            key={object.key}
                            className="group h-[58px] cursor-pointer border-b border-slate-50 transition hover:bg-slate-50/80"
                            onClick={() => setPreview(object)}
                          >
                            <td className="pl-5" onClick={(event) => event.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selected.has(object.key)}
                                onChange={() => toggleSelected(object.key)}
                                aria-label={basename(object.key) + " を選択"}
                                className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                              />
                            </td>
                            <td>
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 transition group-hover:bg-white">
                                  <FileGlyph object={object} />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium text-slate-800 group-hover:text-indigo-700">
                                    {basename(object.key)}
                                  </span>
                                  <span className="block max-w-[360px] truncate font-mono text-[10px] text-slate-400">
                                    {object.key}
                                  </span>
                                </span>
                              </div>
                            </td>
                            <td className="text-xs font-medium text-slate-500">{formatBytes(object.size)}</td>
                            <td className="text-xs text-slate-500">{formatDate(object.uploaded)}</td>
                            <td className="pr-4">
                              <div className="flex justify-end gap-0.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                                <IconButton label="キーをコピー" onClick={() => void copyKey(object.key)}>
                                  <Clipboard className="h-4 w-4" />
                                </IconButton>
                                <a
                                  href={objectUrl(object.key)}
                                  onClick={(event) => event.stopPropagation()}
                                  title="ダウンロード"
                                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                                >
                                  <ArrowDownToLine className="h-4 w-4" />
                                </a>
                                <IconButton label="名前を変更" onClick={() => void renameObject(object)}>
                                  <Pencil className="h-4 w-4" />
                                </IconButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 sm:gap-4 sm:p-5 xl:grid-cols-4">
                    {folders.map((folder) => (
                      <button
                        key={folder}
                        onClick={() => folderPrefix(folder)}
                        className="group overflow-hidden rounded-2xl border border-slate-200 bg-white text-left transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-100/50"
                      >
                        <div className="flex h-32 items-center justify-center bg-gradient-to-br from-amber-50 to-orange-50 text-amber-500">
                          <Folder className="h-12 w-12 stroke-[1.4]" />
                        </div>
                        <div className="flex items-center justify-between p-3.5">
                          <span className="truncate text-sm font-semibold">{basename(folder.replace(/\/$/, ""))}</span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                        </div>
                      </button>
                    ))}
                    {visibleObjects.map((object) => {
                      const type = typeForObject(object);
                      const image = type.startsWith("image/") && type !== "image/svg+xml";
                      return (
                        <article
                          key={object.key}
                          className="group overflow-hidden rounded-2xl border border-slate-200 bg-white transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-100/50"
                        >
                          <button onClick={() => setPreview(object)} className="block w-full text-left">
                            <div className="relative flex h-32 items-center justify-center overflow-hidden bg-slate-100">
                              {image ? (
                                <img
                                  src={objectUrl(object.key, true)}
                                  alt=""
                                  loading="lazy"
                                  className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                                />
                              ) : (
                                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-indigo-600 shadow-sm">
                                  <FileGlyph object={object} />
                                </span>
                              )}
                              <span className="absolute bottom-2 right-2 rounded-md bg-slate-950/60 px-2 py-1 text-[10px] font-semibold text-white">
                                {formatBytes(object.size)}
                              </span>
                            </div>
                            <div className="px-3.5 pb-2 pt-3">
                              <p className="truncate text-sm font-semibold text-slate-800">{basename(object.key)}</p>
                              <p className="mt-1 truncate text-[10px] text-slate-400">{formatDate(object.uploaded)}</p>
                            </div>
                          </button>
                          <div className="flex items-center justify-between border-t border-slate-100 px-2.5 py-1">
                            <label className="flex items-center gap-2 px-1 text-[11px] text-slate-500">
                              <input
                                type="checkbox"
                                checked={selected.has(object.key)}
                                onChange={() => toggleSelected(object.key)}
                                className="h-3.5 w-3.5 rounded accent-indigo-600"
                              />
                              選択
                            </label>
                            <a
                              href={objectUrl(object.key)}
                              title="ダウンロード"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                            >
                              <ArrowDownToLine className="h-4 w-4" />
                            </a>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}

                {!busy && folders.length === 0 && objects.length === 0 && (
                  <div className="flex min-h-[300px] flex-col items-center justify-center px-5 text-center">
                    <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500">
                      <HardDrive className="h-6 w-6" />
                    </span>
                    <h2 className="mt-4 text-base font-semibold text-slate-800">
                      {searchPrefix ? "一致するオブジェクトがありません" : "ここにはまだファイルがありません"}
                    </h2>
                    <p className="mt-1.5 max-w-sm text-sm leading-6 text-slate-500">
                      ファイルをアップロードするか、フォルダーを作成して保存先を整理できます。
                    </p>
                    {!searchPrefix && (
                      <div className="mt-5 flex gap-2">
                        <button
                          onClick={() => fileInput.current?.click()}
                          className="inline-flex h-10 items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700"
                        >
                          <Upload className="h-4 w-4" />
                          アップロード
                        </button>
                        <button
                          onClick={() => void createFolder()}
                          className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <FolderPlus className="h-4 w-4" />
                          フォルダー
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {cursor && (
                  <div className="flex justify-center border-t border-slate-100 p-4">
                    <button
                      onClick={() => void loadNext()}
                      disabled={loadingMore}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                    >
                      {loadingMore ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      次の 200 件を読み込む
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <div className="mt-4 flex flex-col justify-between gap-1.5 px-1 text-[11px] text-slate-400 sm:flex-row">
            <p>{prefix ? "現在の場所: " + prefix : "R2 のルート"}</p>
            <p>検索はキーの先頭一致です。表示件数・容量は読み込み済み分を示します。</p>
          </div>

          {uploads.length > 0 && (
            <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_3px_18px_rgb(15_23_42/4%)]">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5 sm:px-5">
                <div>
                  <h2 className="text-sm font-semibold">アップロード</h2>
                  <p className="mt-0.5 text-[11px] text-slate-400">保存先: {prefix || "ルート"}</p>
                </div>
                <button
                  onClick={() => setUploads((current) => current.filter((item) => item.status === "uploading"))}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100"
                >
                  完了分を閉じる
                </button>
              </div>
              <div className="divide-y divide-slate-100">
                {uploads.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      {item.status === "uploading" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : item.status === "done" ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <File className="h-4 w-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        <span className="shrink-0 text-xs text-slate-500">
                          {item.status === "uploading"
                            ? item.progress + "%"
                            : item.status === "done"
                              ? "完了"
                              : item.status === "skipped"
                                ? "スキップ"
                                : item.status === "cancelled"
                                  ? "中止"
                                  : "失敗"}
                        </span>
                      </div>
                      {item.status === "uploading" ? (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-[width]"
                            style={{ width: item.progress + "%" }}
                          />
                        </div>
                      ) : item.detail ? (
                        <p className="mt-1 truncate text-[11px] text-rose-600">{item.detail}</p>
                      ) : null}
                    </div>
                    {item.status === "uploading" && (
                      <IconButton
                        label="アップロードを中止"
                        onClick={() => controllers.current.get(item.id)?.abort()}
                      >
                        <X className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-indigo-400 bg-indigo-600/10 backdrop-blur-sm">
          <div className="rounded-2xl bg-white px-8 py-6 text-center shadow-xl">
            <Upload className="mx-auto h-8 w-8 text-indigo-600" />
            <p className="mt-3 font-semibold text-slate-900">ここにファイルをドロップ</p>
            <p className="mt-1 text-sm text-slate-500">保存先: {prefix || "ルート"}</p>
          </div>
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                  <FileGlyph object={preview} />
                </span>
                <div className="min-w-0">
                  <h2 id="preview-title" className="truncate text-sm font-semibold text-slate-900">
                    {basename(preview.key)}
                  </h2>
                  <p className="truncate font-mono text-[10px] text-slate-400">
                    {preview.key} · {formatBytes(preview.size)} · {formatDate(preview.uploaded)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <IconButton label="キーをコピー" onClick={() => void copyKey(preview.key)}>
                  <Clipboard className="h-4 w-4" />
                </IconButton>
                <a
                  href={objectUrl(preview.key)}
                  title="ダウンロード"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                >
                  <ArrowDownToLine className="h-4 w-4" />
                </a>
                <IconButton label="名前を変更" onClick={() => void renameObject(preview)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton label="閉じる" onClick={() => setPreview(null)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            </header>
            <div className="flex min-h-[240px] flex-1 items-center justify-center overflow-auto bg-slate-950 p-3 sm:min-h-[400px] sm:p-6">
              {previewType.startsWith("image/") && previewType !== "image/svg+xml" ? (
                <img
                  src={objectUrl(preview.key, true)}
                  alt={basename(preview.key)}
                  className="max-h-[72vh] max-w-full object-contain"
                />
              ) : previewType.startsWith("video/") ? (
                <video
                  key={preview.key}
                  src={objectUrl(preview.key, true)}
                  controls
                  playsInline
                  preload="metadata"
                  className="max-h-[72vh] max-w-full"
                />
              ) : previewType.startsWith("audio/") ? (
                <div className="w-full max-w-xl rounded-2xl bg-white p-6 text-center">
                  <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                    <Music2 className="h-8 w-8" />
                  </span>
                  <p className="mt-4 truncate font-semibold text-slate-900">{basename(preview.key)}</p>
                  <audio className="mt-5 w-full" controls src={objectUrl(preview.key, true)} />
                </div>
              ) : previewType.startsWith("text/") || previewType.includes("json") || previewType.includes("xml") ? (
                <div className="max-h-[72vh] w-full max-w-4xl overflow-auto rounded-xl bg-white p-4 sm:p-6">
                  {previewTextLimited && (
                    <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      大きなファイルの先頭 256 KiB を表示しています。
                    </p>
                  )}
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-slate-800">
                    {previewText}
                  </pre>
                </div>
              ) : previewType === "application/pdf" ? (
                <iframe
                  title={basename(preview.key)}
                  src={objectUrl(preview.key, true)}
                  className="h-[72vh] w-full rounded-lg bg-white"
                />
              ) : (
                <div className="max-w-sm text-center text-white">
                  <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-white">
                    <FileGlyph object={preview} />
                  </span>
                  <p className="mt-4 font-semibold">{basename(preview.key)}</p>
                  <p className="mt-1 text-xs text-white/60">この形式のインラインプレビューには対応していません。</p>
                  <a
                    href={objectUrl(preview.key)}
                    className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-100"
                  >
                    <ArrowDownToLine className="h-4 w-4" />
                    ダウンロード
                  </a>
                </div>
              )}
            </div>
            <footer className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-[11px] text-slate-400 sm:px-5">
              <span className="truncate">{preview.contentType}</span>
              <button
                onClick={() => void deleteObjects([preview.key])}
                className="ml-3 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-semibold text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                削除
              </button>
            </footer>
          </section>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-xl"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
