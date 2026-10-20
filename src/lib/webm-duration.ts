/**
 * Normalize a recorded WebM Blob so it plays in Chrome.
 *
 * Chrome's MediaRecorder produces a "live"/streaming WebM whose EBML
 * `Duration` element is left unset/unknown. Firefox's media demuxer
 * tolerates that; Chrome's does not — Chrome reports "No video with
 * supported format and MIME type" / a decode error and never fires
 * `loadedmetadata`. This is the classic "recording plays in Firefox,
 * not Chrome" defect.
 *
 * `fix-webm-duration` is a tiny, pure-JS, browser-safe EBML patcher (no
 * Node APIs) that rewrites the correct `Duration` into the container
 * given the real recorded duration. It does NOT transcode or re-encode —
 * it only touches container metadata. For non-WebM blobs (mp4 from
 * Safari) this is a no-op: we return the blob untouched.
 *
 * Returns the original blob (unchanged) when the blob isn't WebM, the
 * patcher throws, or the result is empty/invalid.
 */
export async function repairWebmDuration(
  blob: Blob,
  durationMs: number,
  mime: string,
): Promise<Blob> {
  const isWebm = mime.toLowerCase().includes("webm");
  if (!isWebm || blob.size === 0) return blob;
  try {
    const mod = await import("fix-webm-duration");
    const fix = mod.default;
    const out = await fix(blob, Math.max(0, Math.round(durationMs)));
    if (out && out.size > 0) return out;
  } catch (e) {
    console.warn("[webm-duration] repair failed; using original blob", e);
  }
  return blob;
}
