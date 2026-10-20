import {
  createFolder as createFolderFn,
  createUploadUrl as createUploadUrlFn,
  deleteFolder as deleteFolderFn,
  deleteVideo as deleteVideoFn,
  getStorageStatus as getStorageStatusFn,
  getTranscript as getTranscriptFn,
  getVideoMeta as getVideoMetaFn,
  listComments as listCommentsFn,
  listFolders as listFoldersFn,
  listReactions as listReactionsFn,
  listVideos as listVideosFn,
  moveVideo as moveVideoFn,
  saveComments as saveCommentsFn,
  saveFolders as saveFoldersFn,
  saveReactions as saveReactionsFn,
  saveTranscript as saveTranscriptFn,
  saveVideoMeta as saveVideoMetaFn,
} from "./storage.functions";
import {
  deleteBlob,
  deleteVideoMeta,
  getAllVideoMeta,
  getBlob,
  getVideoMeta as getLocalMeta,
  putBlob,
  putVideoMeta,
} from "./local-db";
import type {
  Comment,
  Folder,
  FolderOpResult,
  MoveResult,
  Reaction,
  StorageStatus,
  Transcript,
  VideoRecord,
} from "./types";
import { safeCall, withTimeout } from "./with-timeout";

const DEFAULT_STATUS: StorageStatus = {
  configured: false,
  reachable: false,
  bucketMatch: false,
  expectedBucket: "",
  buckets: [],
  error: "Cloud storage not configured.",
};

export async function fetchStorageStatus(): Promise<StorageStatus> {
  return safeCall(getStorageStatusFn(), DEFAULT_STATUS);
}

export async function fetchVideos(): Promise<VideoRecord[]> {
  const remote = await safeCall(listVideosFn(), []);
  if (remote.length > 0) return remote;
  return safeCall(getAllVideoMeta(), []);
}

export async function fetchVideoMeta(id: string): Promise<VideoRecord | null> {
  const remote = await safeCall(getVideoMetaFn({ data: { id } }), null);
  if (remote) return remote;
  return safeCall(getLocalMeta(id), null);
}

export async function fetchFolders(): Promise<Folder[]> {
  return safeCall(listFoldersFn(), []);
}

export async function persistFolders(folders: Folder[]): Promise<void> {
  await safeCall(saveFoldersFn({ data: { folders } }), undefined);
}

export async function fetchComments(videoId: string): Promise<Comment[]> {
  return safeCall(listCommentsFn({ data: { videoId } }), []);
}

export async function persistComments(videoId: string, comments: Comment[]): Promise<void> {
  await safeCall(saveCommentsFn({ data: { videoId, comments } }), undefined);
}

export async function fetchReactions(videoId: string): Promise<Reaction[]> {
  return safeCall(listReactionsFn({ data: { videoId } }), []);
}

export async function persistReactions(videoId: string, reactions: Reaction[]): Promise<void> {
  await safeCall(saveReactionsFn({ data: { videoId, reactions } }), undefined);
}

export async function fetchTranscript(videoId: string): Promise<Transcript | null> {
  return safeCall(getTranscriptFn({ data: { videoId } }), null);
}

export async function persistTranscript(transcript: Transcript): Promise<void> {
  await safeCall(saveTranscriptFn({ data: { transcript } }), undefined);
}

/**
 * Upload a recording blob DIRECTLY to Cloud Storage using a signed upload URL
 * the server generates. The large video bytes never pass through the Edge
 * worker — base64-over-RPC hits the worker's payload limit for any real
 * recording and times out, which is why every save showed "Cloud not
 * reachable" / local-only. Returns true only when the object was actually
 * uploaded.
 */
async function uploadBlobDirect(
  id: string,
  ext: string,
  blob: Blob,
  mime: string,
): Promise<boolean> {
  const sign = await withTimeout(createUploadUrlFn({ data: { id, ext } }), 12000);
  if (!sign.ok || !sign.url) {
    console.warn("[upload] no signed URL:", sign.error);
    return false;
  }
  // PUT the raw bytes straight to Cloud Storage. No apikey/Authorization
  // header — the signed URL already carries the authorization token and
  // Supabase rejects a request that also sends a service-role header on a
  // signed upload. upsert=true so a retry of the same id replaces cleanly.
  const uploadUrl = sign.url + (sign.url.includes("?") ? "&upsert=true" : "?upsert=true");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      signal: controller.signal,
      headers: {
        "Content-Type": mime || "application/octet-stream",
        "x-upsert": "true",
      },
      body: blob,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[upload] PUT failed:", res.status, text);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[upload] PUT threw:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save a completed recording: upload blob + meta, and cache locally. Uploads
 * the blob directly to Cloud Storage via a signed URL (not base64-over-RPC,
 * which hit the Edge payload limit for real recordings). Only marks the
 * recording as shareable when the upload actually succeeded.
 */
export async function saveRecording(
  record: VideoRecord,
  blob: Blob,
): Promise<{ ok: boolean; localOnly: boolean; message: string | undefined }> {
  // Always cache locally first so it works offline / without a backend.
  try {
    await putBlob(record.id, blob);
    await putVideoMeta(record);
  } catch {
    /* local cache best-effort */
  }

  const uploaded = await uploadBlobDirect(record.id, record.ext, blob, record.mimeType);
  if (uploaded) {
    // Meta is what makes the recording appear in the shared library. Only
    // persist it once the video object exists, so a missing upload is never
    // reported as an available recording on other devices.
    const meta = await safeCall(saveVideoMetaFn({ data: { record } }), { ok: true });
    if (!meta?.ok) {
      return {
        ok: true,
        localOnly: true,
        message: "Uploaded video, but could not save metadata. Retrying soon.",
      };
    }
    return { ok: true, localOnly: false, message: undefined };
  }
  return {
    ok: true,
    localOnly: true,
    message: "Cloud upload failed — saved locally only.",
  };
}

/**
 * Re-upload a local-only recording's bytes to Cloud so it becomes shareable.
 * Used by the watch page's "Sync to Cloud" retry when the original upload
 * failed. Only available on a device that still has the IndexedDB blob.
 */
export async function retryUpload(
  rec: VideoRecord,
  blob: Blob,
): Promise<{ ok: boolean; localOnly: boolean; message: string | undefined }> {
  const uploaded = await uploadBlobDirect(rec.id, rec.ext, blob, rec.mimeType);
  if (uploaded) {
    await safeCall(saveVideoMetaFn({ data: { record: rec } }), { ok: true });
    try {
      await putVideoMeta(rec);
    } catch {
      /* best-effort */
    }
    return { ok: true, localOnly: false, message: undefined };
  }
  return {
    ok: false,
    localOnly: true,
    message: "Cloud upload failed. Try again later.",
  };
}

/** Update a recording's metadata (e.g. edited title/description). */
export async function persistVideoMeta(record: VideoRecord): Promise<void> {
  await safeCall(saveVideoMetaFn({ data: { record } }), undefined);
  try {
    await putVideoMeta(record);
  } catch {
    /* local cache best-effort */
  }
}

export async function removeRecording(id: string, ext: string): Promise<void> {
  await safeCall(deleteVideoFn({ data: { id, ext } }), undefined);
  try {
    await deleteVideoMeta(id);
    await deleteBlob(id);
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve playable URLs for a video. Returns the local IndexedDB blob URL
 * (instant, offline) when available, plus the remote streaming URL as a
 * fallback. The player tries the local URL first and falls back to remote
 * if the blob won't decode — a stale/corrupt local cache must never block
 * playback of a valid remote recording.
 */
export async function resolveVideoUrl(
  id: string,
): Promise<{ primary: string | null; fallback: string | null }> {
  const remote = `/api/video/${id}`;
  const local = await safeCall(getBlob(id), null);
  if (local) {
    return { primary: URL.createObjectURL(local), fallback: remote };
  }
  const rec = await fetchVideoMeta(id);
  return { primary: rec?.storagePath ? remote : null, fallback: null };
}

/* ---- Strict folder/move operations (no swallow) ---- */

/**
 * Create a folder. The id is generated client-side so a retry cannot create
 * duplicates. Surfaces a typed result so the UI can distinguish a real
 * failure from success instead of swallowing it.
 */
export async function createFolderStrict(id: string, name: string): Promise<FolderOpResult> {
  return withTimeout(createFolderFn({ data: { id, name } }), 12000);
}

export async function deleteFolderStrict(id: string): Promise<FolderOpResult> {
  return withTimeout(deleteFolderFn({ data: { id } }), 12000);
}

/**
 * Move a recording's folder assignment. Updates only metadata — the video
 * binary is never relocated. Surfaces a typed result distinguishing a real
 * failure ("not found", "invalid folder", transport) from a confirmed move.
 * On a confirmed cloud move, syncs the local IndexedDB cache too.
 */
export async function moveVideoStrict(
  videoId: string,
  folderId: string | null,
): Promise<MoveResult> {
  const res = await withTimeout(moveVideoFn({ data: { videoId, folderId } }), 12000);
  if (res.ok && res.record) {
    try {
      await putVideoMeta(res.record);
    } catch {
      /* local cache best-effort */
    }
  }
  return res;
}

/**
 * Derive the correct on-disk extension for a recording from its actual MIME
 * type — never from a renamed one. Renaming .webm → .mp4 does NOT transcode:
 * it produces an .mp4-named WebM that local media players (QuickTime, Windows
 * Media) reject. The recorder records WebM (VP9/VP8 + Opus) on Chrome/Firefox,
 * so the honest extension is .webm; only genuine MP4 containers get .mp4.
 */
export function extForMime(mime: string | undefined): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("mp4") || m === "video/mp4") return "mp4";
  return "webm";
}

export function slugify(title: string | undefined): string {
  const s = (title ?? "swift-screen").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
  return s.replace(/^-+|-+$/g, "").slice(0, 80) || "swift-screen";
}

/**
 * Trigger a real file download for a recording.
 *
 * Browsers IGNORE the <a download> attribute when the href cross-redirects
 * to a cross-origin URL — which is exactly what the playback 302 (→ Supabase
 * CDN) does, so the old <a href="/api/video/$id" download> button navigated/
 * played instead of saving. This instead:
 *   1. Prefers the local IndexedDB blob when present → a same-origin blob:
 *      URL, where the download attribute IS honored, and the file saves with
 *      the correct .webm/.mp4 extension. This is also the ONLY copy that
 *      exists for local-only recordings whose cloud blob upload fell over.
 *   2. Falls back to a same-origin stream from /api/video/$id?download=1,
 *      which the worker serves with Content-Disposition: attachment. A
 *      same-origin attachment response forces a real save regardless of
 *      container, and the server reads the bytes with the service-role key
 *      (no signed-URL expiry edge cases).
 */
export async function triggerVideoDownload(rec: VideoRecord): Promise<void> {
  const ext = rec.ext || extForMime(rec.mimeType);
  const filename = `${slugify(rec.title)}.${ext}`;

  // 1) Local blob first (same-origin → download attribute honored).
  try {
    const blob = await getBlob(rec.id);
    if (blob && blob.size > 0) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return;
    }
  } catch {
    /* fall through to cloud */
  }

  // 2) Same-origin attachment stream from the worker.
  const a = document.createElement("a");
  a.href = `/api/video/${rec.id}?download=1`;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
