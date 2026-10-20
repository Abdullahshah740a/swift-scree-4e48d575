import { checkVideoObject as checkVideoObjectFn } from "./storage.functions";
import {
  deleteBlob,
  deleteVideoMeta,
  getAllVideoMeta,
  getBlob,
  getVideoMeta as getLocalMeta,
  putBlob,
  putVideoMeta,
} from "./local-db";
import { formatBytes } from "./format";
import type {
  Comment,
  Folder,
  FolderOpResult,
  MoveResult,
  Reaction,
  StorageStatus,
  SyncDiagnostics,
  Transcript,
  VideoObjectCheck,
  VideoRecord,
} from "./types";
import { safeCall, withTimeout } from "./with-timeout";
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
} from "./storage.functions";

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
 * See the StorageStatus / VideoObjectCheck docs for the present/missing/unknown
 * contract. The check may be retried by the caller.
 */
export async function fetchVideoObjectStatus(id: string, ext: string): Promise<VideoObjectCheck> {
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
 * Upload a recording blob to Cloud Storage through the same-origin Edge
 * worker proxy at /api/upload/$id. The browser POSTs the raw bytes to the
 * proxy (same-origin — no CORS preflight); the proxy forwards them to Cloud
 * Storage with the service-role key (key never reaches the browser) and
 * returns the object path.
 *
 * WHY same-origin proxy and not a direct browser PUT to a signed upload URL:
 * the bucket would need CORS rules for the app's origin to allow a
 * cross-origin PUT, which the platform does not guarantee and we cannot set
 * from here. A direct cross-origin PUT is rejected at the preflight and
 * surfaces as "Failed to fetch" (TypeError) with NO HTTP response even for a
 * tiny recording — exactly the regression observed (3ab… 153 KB, ~1.5s). The
 * same-origin proxy avoids the cross-origin preflight entirely; this is the
 * path that previously worked for small uploads.
 *
 * The larger-upload 120s timeout that the direct-PUT attempt tried to work
 * around remains UNRESOLVED for now — the proxy still buffers the body
 * server-side, so a multi-MB recording may still stall on the preview
 * gateway's request-body path. That is a separate, pre-existing issue and
 * does not block small/normal recordings.
 *
 * Diagnostics label the stage "upload" and distinguish a real HTTP rejection
 * (server-rejected, with the proxy/upstream status) from a transport failure
 * (network / fetch-aborted, no response). The signed URL/token is NEVER
 * included in a diagnostic — see redactSignedUrl, which scrubs any
 * token/sig/signature/url query param.
 *
 * Returns true ONLY when the proxy returned 2xx (the object was accepted).
 */
function redactSignedUrl(s: string | undefined | null): string {
  if (!s) return "";
  // Strip any query params that could carry a token/signature/signed URL so a
  // diagnostic never leaks a credential. Cloud Storage error bodies don't
  // normally include them, but this guarantees it before surfacing text.
  return s.replace(/[?&][^&\s]*(token|sig|signature|url|secret)=[^&\s]*/gi, "[redacted]");
}

async function uploadBlobDirect(
  id: string,
  ext: string,
  blob: Blob,
  mime: string,
): Promise<{ ok: boolean; status?: number; error?: string; diag: SyncDiagnostics }> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const base: Omit<SyncDiagnostics, "failed" | "stage"> = {
    recordingId: id,
    blobSize: blob.size,
    blobSizeMb: formatBytes(blob.size),
    mimeType: mime,
    ext,
    elapsedMs: null,
    startedAt: startedAtIso,
    httpStatus: null,
    errorKind: "ok",
    errorMessage: null,
    rawName: null,
  };

  // 1) Reachability probe: a tiny GET to the same route. If this also fails
  //    with "Failed to fetch", the cause is route reachability (network/
  //    gateway/CSP), NOT the POST body or size — and we surface that
  //    distinction in the diagnostic instead of guessing.
  try {
    const probe = await fetch(`/api/upload/${id}`, {
      method: "GET",
      // short, bounded — a route-reachability check should never take long
      signal: AbortSignal.timeout(8000),
    });
    if (!probe.ok) {
      const msg = `Upload route unreachable (GET ${probe.status})`;
      console.warn("[upload] probe failed:", probe.status);
      return {
        ok: false,
        error: msg,
        diag: {
          ...base,
          stage: "upload",
          failed: true,
          elapsedMs: Date.now() - startedAtMs,
          httpStatus: probe.status,
          errorKind: "server-rejected",
          errorMessage: msg,
          rawName: "Probe",
        },
      };
    }
  } catch (e) {
    const msg = "Upload route not reachable from browser (GET failed)";
    console.warn("[upload] probe threw:", e instanceof Error ? e.name : "Error");
    return {
      ok: false,
      error: msg,
      diag: {
        ...base,
        stage: "upload",
        failed: true,
        elapsedMs: Date.now() - startedAtMs,
        httpStatus: null,
        errorKind: "route-unreachable",
        errorMessage: msg,
        rawName: e instanceof Error ? e.name : "Error",
      },
    };
  }

  // 2) Same-origin POST to the Edge worker proxy. The proxy forwards the bytes
  //    to Cloud Storage with the service-role key; the browser never makes a
  //    cross-origin request, so there is no CORS preflight to reject. Bounded by
  //    an AbortController so a stall surfaces as a real error instead of hanging.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`/api/upload/${id}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": mime || "application/octet-stream",
        "x-ext": ext,
      },
      body: blob,
    });
    const elapsedMs = Date.now() - startedAtMs;
    if (!res.ok) {
      const text = redactSignedUrl(await res.text().catch(() => ""));
      const msg = `Upload failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`;
      console.warn("[upload] proxy failed:", res.status, text);
      return {
        ok: false,
        status: res.status,
        error: msg,
        diag: {
          ...base,
          stage: "upload",
          failed: true,
          elapsedMs,
          httpStatus: res.status,
          errorKind: "server-rejected",
          errorMessage: msg,
          rawName: "Response",
        },
      };
    }
    return { ok: true, diag: { ...base, stage: "upload", failed: false, elapsedMs } };
  } catch (e) {
    const elapsedMs = Date.now() - startedAtMs;
    const raw = e instanceof Error ? e.name : "Error";
    const isAbort = e instanceof Error && e.name === "AbortError";
    const kind = isAbort ? "fetch-aborted" : "network";
    const msg = redactSignedUrl(e instanceof Error ? e.message : "Upload transport error");
    console.warn("[upload] proxy threw:", raw, msg);
    return {
      ok: false,
      error: msg,
      diag: {
        ...base,
        stage: "upload",
        failed: true,
        elapsedMs,
        httpStatus: null,
        errorKind: kind,
        errorMessage: msg,
        rawName: raw,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save a completed recording: upload blob + meta, and cache locally. Uploads
 * the blob DIRECTLY to Cloud Storage via a server-signed URL (not through the
 * Edge worker, which stalls for multi-MB bodies on the preview gateway — see
 * uploadBlobDirect). Only marks the recording as shareable (localOnly=false)
 * when BOTH the video object AND its metadata actually persisted to Cloud —
 * so "Saved to Cloud" is never shown for a recording whose binary is missing.
 */
export async function saveRecording(
  record: VideoRecord,
  blob: Blob,
): Promise<{
  ok: boolean;
  localOnly: boolean;
  message: string | undefined;
  verified?: boolean;
  diag: SyncDiagnostics | null;
}> {
  // Always cache locally first so it works offline / without a backend, and
  // so a failed cloud upload can be retried later from this device.
  let localSaved = false;
  let localErr: string | undefined;
  try {
    await putBlob(record.id, blob);
    await putVideoMeta({ ...record, localOnly: true });
    localSaved = true;
  } catch (e) {
    localErr = e instanceof Error ? e.message : "Local cache write failed";
    console.warn("[save] local cache failed:", localErr);
  }

  const upload = await uploadBlobDirect(record.id, record.ext, blob, record.mimeType);
  if (upload.ok) {
    // Meta is what makes the recording appear in the shared library. Only
    // persist it once the video object exists, and mark it NOT localOnly.
    // Do NOT wrap this in safeCall with a success-shaped default — that
    // masks a metadata write failure as success and reports "Saved to Cloud"
    // for a recording that won't appear in the shared library. A throw here
    // is a real failure: downgrade to local-only with the real error.
    const cloudRecord = { ...record, localOnly: false };
    let metaOk = false;
    let metaErr: string | undefined;
    try {
      const meta = await withTimeout(saveVideoMetaFn({ data: { record: cloudRecord } }), 12000);
      metaOk = Boolean(meta?.ok);
    } catch (e) {
      metaErr = e instanceof Error ? e.message : "Metadata save failed";
      console.warn("[save] meta save failed:", metaErr);
    }
    if (!metaOk) {
      return {
        ok: true,
        localOnly: true,
        message: `Video uploaded, but metadata could not be saved${metaErr ? ` (${metaErr})` : ""}. Saved locally only — use “Sync to Cloud” to retry.`,
        diag: {
          recordingId: record.id,
          stage: "metadata",
          failed: true,
          blobSize: blob.size,
          blobSizeMb: formatBytes(blob.size),
          mimeType: record.mimeType,
          ext: record.ext,
          elapsedMs: null,
          startedAt: new Date().toISOString(),
          httpStatus: null,
          errorKind: "server-rejected",
          errorMessage: metaErr ?? "Metadata save did not confirm.",
          rawName: "MetaSave",
        },
      };
    }
    // Update the local cache to reflect the confirmed cloud state.
    try {
      await putVideoMeta(cloudRecord);
    } catch {
      /* best-effort */
    }
    // Best-effort byte-size verification: HEAD the stored object and compare
    // its content-length to the source Blob size. A successful PUT only proves
    // the upload accepted the bytes; a matching HEAD size is the closest
    // available proof the stored bytes match the source.
    let verified = false;
    let verifyDiag: SyncDiagnostics | null = null;
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
      verifyDiag = {
        recordingId: record.id,
        stage: "verify",
        failed: check.status !== "present" || (check.size !== null && check.size !== blob.size),
        blobSize: blob.size,
        blobSizeMb: formatBytes(blob.size),
        mimeType: record.mimeType,
        ext: record.ext,
        elapsedMs: null,
        startedAt: new Date().toISOString(),
        httpStatus: null,
        errorKind: check.status === "present" ? "ok" : check.status,
        errorMessage: check.error ?? null,
        rawName: null,
      };
    } catch {
      /* verification unavailable — uploaded but unverified */
    }
    return { ok: true, localOnly: false, message: undefined, verified, diag: verifyDiag };
  }
  // Upload failed. Preserve the real error so the user sees the actual cause
  // (transport, signed-URL rejection, etc.) instead of a generic banner.
  const reason = upload.error ?? "Cloud upload failed.";
  return {
    ok: localSaved,
    localOnly: true,
    message: localSaved
      ? `${reason} Saved locally only — use “Sync to Cloud” to retry.`
      : `${reason} Local cache also failed${localErr ? ` (${localErr})` : ""}.`,
    diag: upload.diag,
  };
}

/**
 * Re-upload a local-only recording's bytes to Cloud so it becomes shareable.
 * Used by the watch page's "Sync to Cloud" retry. Only available on a device
 * that still has the IndexedDB blob. Preserves the recording's id (no dupes).
 */
export async function retryUpload(
  rec: VideoRecord,
  blob: Blob,
): Promise<{
  ok: boolean;
  localOnly: boolean;
  message: string | undefined;
  verified?: boolean;
  diag: SyncDiagnostics | null;
}> {
  const upload = await uploadBlobDirect(rec.id, rec.ext, blob, rec.mimeType);
  if (upload.ok) {
    const cloudRecord = { ...rec, localOnly: false };
    // Same as saveRecording: do NOT mask a metadata write failure as success.
    let metaOk = false;
    let metaErr: string | undefined;
    try {
      const meta = await withTimeout(saveVideoMetaFn({ data: { record: cloudRecord } }), 12000);
      metaOk = Boolean(meta?.ok);
    } catch (e) {
      metaErr = e instanceof Error ? e.message : "Metadata save failed";
      console.warn("[retry] meta save failed:", metaErr);
    }
    if (!metaOk) {
      return {
        ok: false,
        localOnly: true,
        message: `Video uploaded, but metadata could not be saved${metaErr ? ` (${metaErr})` : ""}. Try again.`,
        diag: {
          recordingId: rec.id,
          stage: "metadata",
          failed: true,
          blobSize: blob.size,
          blobSizeMb: formatBytes(blob.size),
          mimeType: rec.mimeType,
          ext: rec.ext,
          elapsedMs: null,
          startedAt: new Date().toISOString(),
          httpStatus: null,
          errorKind: "server-rejected",
          errorMessage: metaErr ?? "Metadata save did not confirm.",
          rawName: "MetaSave",
        },
      };
    }
    try {
      await putVideoMeta(cloudRecord);
    } catch {
      /* best-effort */
    }
    // Best-effort byte-size verification (see saveRecording).
    let verified = false;
    let verifyDiag: SyncDiagnostics | null = null;
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
      verifyDiag = {
        recordingId: rec.id,
        stage: "verify",
        failed: check.status !== "present" || (check.size !== null && check.size !== blob.size),
        blobSize: blob.size,
        blobSizeMb: formatBytes(blob.size),
        mimeType: rec.mimeType,
        ext: rec.ext,
        elapsedMs: null,
        startedAt: new Date().toISOString(),
        httpStatus: null,
        errorKind: check.status === "present" ? "ok" : check.status,
        errorMessage: check.error ?? null,
        rawName: null,
      };
    } catch {
      /* verification unavailable — uploaded but unverified */
    }
    return { ok: true, localOnly: false, message: undefined, verified, diag: verifyDiag };
  }
  return {
    ok: false,
    localOnly: true,
    message: upload.error ?? "Cloud upload failed. Try again later.",
    diag: upload.diag,
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

export async function createFolderStrict(id: string, name: string): Promise<FolderOpResult> {
  return withTimeout(createFolderFn({ data: { id, name } }), 12000);
}

export async function deleteFolderStrict(id: string): Promise<FolderOpResult> {
  return withTimeout(deleteFolderFn({ data: { id } }), 12000);
}

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
