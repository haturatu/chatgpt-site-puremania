# Pure Mania on ChatGPT Sites

**ChatGPT Sites documents R2 object storage as having no fixed storage limit as of October 31, 2026.** For that reason, this repository is a full migration of [Pure Mania](https://github.com/haturatu/puremania/) for ChatGPT Sites (Cloudflare). It carries over the original frontend and file-management workflows, with file operations backed by the Site's Cloudflare R2 binding. Shared Sites usage limits still apply.

The original browser interface includes navigation, keyboard shortcuts, an image gallery, a media player, search, a text editor, an upload manager and a visual file list. Frontend modules, templates and styles are served from `/static`. Runtime-specific differences are listed below.

## Uploads

The original adaptive uploader is retained: it slices each browser `File` lazily into 8 MiB requests, starts with two concurrent files, adjusts concurrency in response to request throughput and server feedback up to 32 files, retries failed chunks up to five times, and records session metadata in IndexedDB. The file bytes are not copied into IndexedDB. R2 multipart upload IDs, chunk offsets and ETags are stored in a hidden R2 metadata prefix so the server can report authoritative progress after a refresh. To continue an interrupted job, select the same files again so the browser can provide their bytes.

R2 multipart upload allows up to 10,000 parts, so the current 8 MiB chunk format supports files up to about 78 GiB. Byte-range reads are used for media playback and large previews.

## Object storage mapping

- Object keys map to Pure Mania paths. `/` is the bucket root; nested keys become folders.
- Empty folders use a `.keep` marker. Internal upload session and one-time ZIP download metadata live under `.__puremania__/` and are hidden from the browser.
- Directory views retain the original 200-item pagination and support previous/next navigation with R2 cursors. Search scans up to 50,000 keys per request before returning a continuation cursor.
- Multi-item downloads are streamed as ZIP archives. ZIP extraction is streamed into R2 with path checks and size limits.
- The R2 binding exposes no account quota or total-storage statistic, so the sidebar labels the service as R2 object storage.

## Runtime differences

The hosted Worker does not run the original Go server or external aria2 daemon. The aria2 page is disabled. ZIP extraction is supported; RAR and 7z extraction are not available in this Worker implementation. The Site relies on its private Sites access boundary and stores no bucket credentials in source.

## ChatGPT Sites private authentication

Keep the Site's access mode private in ChatGPT Sites. Sites Dispatch owns sign-in, sign-out and callback routes and supplies the trusted `oai-authenticated-user-id` and `oai-authenticated-user-email` headers to authenticated requests. The home page requires a ChatGPT identity and redirects unauthenticated visitors to the Sites-managed sign-in route. The Worker also rejects every `/api/` request without both identity headers and marks the 401 response private and non-cacheable. Local development bypasses these hosted identity checks. No OAuth client secret, session cookie or custom authentication endpoint is needed in this repository; clones should set their own Site access policy in ChatGPT Sites.
