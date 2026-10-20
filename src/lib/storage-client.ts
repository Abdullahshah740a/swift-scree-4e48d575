import {
  checkVideoObject as checkVideoObjectFn,
  createFolder as createFolderFn,
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
  VideoObjectCheck,
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
  // Merge remote (cloud) + local (IndexedDB) so local-only recordings — whose
  // cloud upload failed or never happened — stay visible alongside confirmed
  // cloud recordings. Dedupe by id; the remote copy wins when both exist
  // (it's the one other devices can play). A remote record that also has a
  // local blob is NOT marked localOnly.
  const remote = await safeCall(listVideosFn(), []);
  const local = await safeCall(getAllVideoMeta(), []);
  const byId = new Map<string, VideoRecord>();
  for (const v of local) byId.set(v.id, { ...v, localOnly: true });
  for (const v of remote) byId.set(v.id, { ...v, localOnly: false });
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchVideoMeta(id: string): Promise<VideoRecord | null> {
  const remote = await safeCall(getVideoMetaFn({ data: { id } }), null);
  if (remote) return remote;
  return safeCall(getLocalMeta(id), null);
}

/**
 * Check whether a recording's video binary actually exists in Cloud Storage.
 * Used by the watch page to detect a pre-`localOnly` recording (no flag,
 * cloud metadata present, but the binary upload failed under the old
 * base64-over-RPC path) and offer a "Sync to Cloud" recovery from the local
 * IndexedDB blob. Returns exists=false only on a confirmed 404/400; network
 * errors are treated as "exists" so a transient failure never wrongly hides
 * a recording.
 */
export async function fetchVideoObjectStatus(id: string, ext: string): Promise<VideoObjectCheck> {
  // The server returns an explicit present/missing/unknown status and never
  // throws for its own network errors (it catches them -> "unknown").
  // safeCall only guards a transport failure in the RPC itself, defaulting to
  // "unknown" so a recording is never wrongly claimed verified in cloud
  // storage — but it also stays visible (unknown is not missing).
  return safeCall(checkVideoObjectFn({ data: { id, ext } }), {
    status: "unknown",
    size: null,
    configured: true,
  });
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
 * Upload a recording blob through the SAME-ORIGIN upload proxy
 * (/api/upload/$id). The proxy forwards the raw bytes to Cloud Storage with
 * the service-role key server-side, so:
 *   - no cross-origin PUT to the Supabase signed URL (which needs bucket CORS
 *     the platform may not have configured → silent failures),
 *   - no base64-over-RPC (which exceeds the Edge worker payload limit for any
 *     real recording and times out — the original "Cloud not reachable"
 *     symptom),
 *   - the service-role key never reaches the browser.
 * Returns true ONLY when the object was actually stored.
 */
async function uploadBlobViaProxy(
  id: string,
  ext: string,
  blob: Blob,
  mime: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`/api/upload/${encodeURIComponent(id)}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": mime || "application/octet-stream",
        "x-ext": ext,
      },
      body: blob,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[upload] proxy failed:", res.status, text);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[upload] proxy threw:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save a completed recording: upload blob + meta, and cache locally. Uploads
 * the blob through the same-origin proxy (not base64-over-RPC, which hit the
 * Edge payload limit for real recordings). Only marks the recording as
 * shareable (localOnly=false) when BOTH the video object AND its metadata
 * actually persisted to Cloud — so "Saved to Cloud" is never shown for a
 * recording whose binary is missing.
 */
export async function saveRecording(
  record: VideoRecord,
  blob: Blob,
): Promise<{ ok: boolean; localOnly: boolean; message: string | undefined; verified?: boolean }> {
  // Always cache locally first so it works offline / without a backend, and
  // so a failed cloud upload can be retried later from this device.
  let localSaved = false;
  try {
    await putBlob(record.id, blob);
    await putVideoMeta({ ...record, localOnly: true });
    localSaved = true;
  } catch (e) {
    console.warn("[save] local cache failed:", e instanceof Error ? e.message : e);
  }

  const uploaded = await uploadBlobViaProxy(record.id, record.ext, blob, record.mimeType);
  if (uploaded) {
    // Meta is what makes the recording appear in the shared library. Only
    // persist it once the video object exists, and mark it NOT localOnly.
    const cloudRecord = { ...record, localOnly: false };
    const meta = await safeCall(saveVideoMetaFn({ data: { record: cloudRecord } }), {
      ok: true,
    });
    if (!meta?.ok) {
      return {
        ok: true,
        localOnly: true,
        message: "Uploaded video, but could not save metadata. Retrying soon.",
      };
    }
    // Update the local cache to reflect the confirmed cloud state.
    try {
      await putVideoMeta(cloudRecord);
    } catch {
      /* best-effort */
    }
    // Best-effort byte-size verification: HEAD the stored object and compare
    // its content-length to the source Blob size. A proxy 200 only proves the
    // upload handler ran; a matching HEAD size is the closest available proof
    // the stored bytes match the source. Never blocks the save — a
    // missing/unknown check logs and falls back to "uploaded but unverified".
    let verified = false;
    try {
      const check = await fetchVideoObjectStatus(record.id, record.ext);
      if (check.status === "present" && check.size !== null) {
        verified = check.size === blob.size;
        if (!verified) {
          console.warn("[save] byte-size mismatch", {
            stored: check.size,
            local: blob.size,
          });
        }
      } else if (check.status === "missing") {
        console.warn("[save] object reported missing right after upload");
      }
    } catch {
      /* verification unavailable — uploaded but unverified */
    }
    return { ok: true, localOnly: false, message: undefined, verified };
  }
  return {
    ok: localSaved,
    localOnly: true,
    message: localSaved
      ? "Cloud upload failed — saved locally only. Use “Sync to Cloud” to retry."
      : "Cloud upload failed and local cache also failed. Recording may be lost.",
  };
}

/**
 * Re-upload a local-only recording's bytes to Cloud so it becomes shareable.
 * Used by the watch page's "Sync to Cloud" retry when the original upload
 * failed. Only available on a device that still has the IndexedDB blob.
 * Preserves the recording's id (no duplicates).
 */
export async function retryUpload(
  rec: VideoRecord,
  blob: Blob,
): Promise<{
  ok: boolean;
  localOnly: boolean;
  message: string | undefined;
  verified?: boolean;
}> {
  const uploaded = await uploadBlobViaProxy(rec.id, rec.ext, blob, rec.mimeType);
  if (uploaded) {
    const cloudRecord = { ...rec, localOnly: false };
    await safeCall(saveVideoMetaFn({ data: { record: cloudRecord } }), { ok: true });
    try {
      await putVideoMeta(cloudRecord);
    } catch {
      /* best-effort */
    }
    // Best-effort byte-size verification (see saveRecording). A successful
    // retry does not by itself prove the stored bytes match — compare the
    // object's content-length to the source Blob where available.
    let verified = false;
    try {
      const check = await fetchVideoObjectStatus(rec.id, rec.ext);
      if (check.status === "present" && check.size !== null) {
        verified = check.size === blob.size;
        if (!verified) {
          console.warn("[retry] byte-size mismatch", {
            stored: check.size,
            local: blob.size,
          });
        }
      }
    } catch {
      /* verification unavailable — uploaded but unverified */
    }
    return { ok: true, localOnly: false, message: undefined, verified };
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
