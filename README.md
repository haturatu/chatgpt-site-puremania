<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Pure Mania on ChatGPT Sites](#pure-mania-on-chatgpt-sites)
  - [Features](#features)
  - [Large uploads](#large-uploads)
  - [R2 storage](#r2-storage)
  - [ChatGPT Sites runtime](#chatgpt-sites-runtime)
  - [Authentication and access](#authentication-and-access)
  - [Source layout](#source-layout)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Pure Mania on ChatGPT Sites

Pure Mania is a web-based file manager written in Go. This repository contains its full migration for ChatGPT Sites (Cloudflare). It keeps the original browser interface and file-management features. The Site stores files in its Cloudflare R2 bucket; runtime-specific limits are listed below.

As of October 31, 2026, [ChatGPT Sites documents no fixed storage limit for R2](https://learn.chatgpt.com/docs/sites?surface=app). This motivated the migration. Shared Sites usage limits still apply.

## Features

- Browse files and folders with list, grid, gallery and media-player views.
- Upload files and folders, including large files.
- Search the current folder or search recursively.
- Preview images, play audio and video, and edit supported text files.
- Create folders and files; rename, move and delete items.
- Download multiple items as a ZIP archive and extract ZIP files.
- Use keyboard shortcuts to navigate and manage files.

## Large uploads

The uploader sends files in 8 MiB chunks. It reads each chunk from the browser `File` as needed instead of loading the whole file into memory.

- Upload concurrency starts at two files and adjusts automatically up to 32.
- Failed chunks are retried up to five times.
- The browser stores upload session details in IndexedDB. File contents stay in the browser and are not stored there.
- The Site stores multipart upload IDs, completed chunk offsets and ETags under the hidden `.__puremania__/` prefix in R2.
- To resume an interrupted upload after a reload, select the same files again.
- This implementation supports files up to 10,000 × 8 MiB (about 78.1 GiB) per file.

## R2 storage

- The bucket root maps to `/`. Nested object keys map to folders.
- Empty folders use a `.keep` marker object.
- The `.__puremania__/` prefix stores upload sessions and temporary ZIP download metadata. The file browser hides this prefix.
- Directory listings show 200 items per page and use R2 cursors for next and previous navigation.
- A search request scans up to 50,000 object keys before it returns a continuation cursor.
- Byte-range reads support media playback and large previews.
- The R2 binding does not report account-wide storage usage. The sidebar therefore labels the service as R2 object storage instead of showing a used/total capacity.

## ChatGPT Sites runtime

The original Pure Mania server is written in Go. ChatGPT Sites runs this port as a Cloudflare Worker and uses the Site's R2 binding for file operations.

- The Go server and the external `aria2c` daemon do not run in this Worker. The aria2 page is disabled.
- ZIP extraction is supported. RAR, 7z, TAR and other archive formats are not supported.
- The source contains no R2 credentials. The Worker reads files through its R2 binding.

## Authentication and access

Keep the Site's access mode private in ChatGPT Sites.

- Sites Dispatch provides the sign-in, sign-out and callback routes.
- The home page redirects visitors without a ChatGPT identity to the Sites sign-in route.
- In production, the Worker rejects `/api/` requests that do not include both `oai-authenticated-user-id` and `oai-authenticated-user-email` headers. Rejected requests receive a private, non-cacheable `401` response.
- Local development skips these hosted identity checks.
- The repository needs no OAuth client secret, session cookie or custom authentication route. Configure access for each copy in ChatGPT Sites.

## Source layout

- `public/static/` contains the Pure Mania browser interface, templates and styles.
- `app/api/` contains the file-management API routes used by the interface.
- `app/lib/` contains R2 helpers, path handling, upload sessions and ZIP operations.
- `worker/index.ts` checks ChatGPT identity headers before forwarding production requests.
