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
): Promise<{ ok: boolean; localOnly: boolean }> {
  // Always cache locally first so it works offline / without a backend.
  try {
    await putBlob(record.id, blob);
    await putVideoMeta(record);
  } catch {
    /* local cache best-effort */
  }

  try {
    const base64 = await blobToBase64(blob);
    await withTimeout(uploadVideoFn({ data: { record, base64 } }), 25000);
    return { ok: true, localOnly: false };
  } catch {
    // Cloud failed; the local copy still exists. Try to persist just the meta.
    void safeCall(saveVideoMetaFn({ data: { record } }), undefined);
    return { ok: true, localOnly: true };
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
  // The downloaded file always carries a .mp4 extension regardless of the
  // stored container — the underlying bytes are not transcoded, only the
  // on-disk filename is normalized to .mp4.
  const filename = `${slugify(rec.title)}.mp4`;

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
