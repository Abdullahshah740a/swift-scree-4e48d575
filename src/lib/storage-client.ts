import {
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
  uploadVideo as uploadVideoFn,
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
// Re-export getBlob so the watch page can read the local-only blob for a
// "Retry sync to Cloud" action without reaching into local-db directly.
export { getBlob };
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

/** Save a completed recording: upload blob + meta, and cache locally. */
export async function saveRecording(
  record: VideoRecord,
  blob: Blob,
): Promise<{ ok: boolean; localOnly: boolean; message?: string }> {
  // Always cache locally first so it works offline / without a backend.
  try {
    await putBlob(record.id, blob);
    await putVideoMeta({ ...record, uploaded: false });
  } catch {
    /* local cache best-effort */
  }

  const base64 = await blobToBase64(blob);
  try {
    const res = await withTimeout(uploadVideoFn({ data: { record, base64 } }), 25000);
    if (!res?.ok || !res?.verified) {
      // Upload failed OR not verified present in Cloud. Keep it local-only —
      // never advertise a shareable cloud copy that another device can't open.
      // The local meta stays marked uploaded:false so the UI shows "Local only".
      return {
        ok: false,
        localOnly: true,
        message: res?.message ?? "Upload could not be verified.",
      };
    }
    // Cloud copy confirmed. Update the local cache so it matches.
    try {
      await putVideoMeta({ ...record, uploaded: true });
    } catch {
      /* local cache best-effort */
    }
    return { ok: true, localOnly: false };
  } catch (e) {
    return {
      ok: false,
      localOnly: true,
      message: e instanceof Error ? e.message : "Upload failed.",
    };
  }
}

/**
 * Retry uploading a local-only recording to Cloud. Used by the watch page /
 * "Local only — Retry sync" action when the original upload failed. Returns
 * the truthful upload result.
 */
export async function retryUpload(
  record: VideoRecord,
  blob: Blob,
): Promise<{ ok: boolean; localOnly: boolean; message?: string }> {
  const base64 = await blobToBase64(blob);
  try {
    const res = await withTimeout(uploadVideoFn({ data: { record, base64 } }), 25000);
    if (!res?.ok || !res?.verified) {
      return { ok: false, localOnly: true, message: res?.message ?? "Upload not verified." };
    }
    try {
      await putVideoMeta({ ...record, uploaded: true });
    } catch {
      /* best-effort */
    }
    return { ok: true, localOnly: false };
  } catch (e) {
    return {
      ok: false,
      localOnly: true,
      message: e instanceof Error ? e.message : "Upload failed.",
    };
  }
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
 * Resolve playable URLs for a video.
 *
 * The Cloud copy is authoritative. The local IndexedDB blob is preferred for
 * instant offline playback, but ONLY as a *fallback candidate* when it is
 * the only copy — a local-only recording (uploaded:false) must never be
 * advertised as a Cloud URL for another browser, because that device has no
 * copy and would hit a missing-file "decode" error.
 *
 * For a confirmed Cloud recording we surface the same-origin streaming
 * endpoint (`/api/video/<id>`, which 302s to a signed Cloud URL). The local
 * blob is the fallback if the stream can't decode on this device.
 */
export async function resolveVideoUrl(
  id: string,
): Promise<{ primary: string | null; fallback: string | null; localOnly: boolean }> {
  const remote = `/api/video/${id}`;
  const rec = await fetchVideoMeta(id);

  // Cloud-confirmed recording: stream from Cloud, with the local blob as a
  // device-side fallback for offline or decode issues.
  if (rec?.uploaded && rec.storagePath) {
    const local = await safeCall(getBlob(id), null);
    if (local && local.size > 0) {
      return { primary: remote, fallback: URL.createObjectURL(local), localOnly: false };
    }
    return { primary: remote, fallback: null, localOnly: false };
  }

  // Local-only recording (upload never verified). The only copy that exists
  // is this device's IndexedDB blob — return it and flag localOnly so the UI
  // can explain that and offer a retry sync.
  const local = await safeCall(getBlob(id), null);
  if (local && local.size > 0) {
    return { primary: URL.createObjectURL(local), fallback: null, localOnly: true };
  }
  // No usable copy anywhere.
  return { primary: null, fallback: null, localOnly: !!(rec && !rec.uploaded) };
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
