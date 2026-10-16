import type { SourceType } from "./types";
// sourceTypeLabel lives in ./format now; media.ts is browser capture only.

/**
 * Choose a MediaRecorder mimeType the browser supports. WebM (VP9/VP8 + Opus)
 * is prioritized because MediaRecorder records it reliably in Chromium and
 * Firefox and <video> decodes it incrementally over HTTP. MP4 is kept only
 * as a last-resort fallback for Safari, which historically couldn't record
 * WebM — Chrome's MediaRecorder MP4 output is fragmented and often fails
 * to play back without a transcode-mux.
 */
export function pickMimeType(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === "undefined") {
    return { mimeType: "video/webm", ext: "webm" };
  }

  // Prioritize webm because MediaRecorder in modern Chromium and Firefox
  // records webm reliably with VP8/VP9 and Opus audio, and standard <video> can
  // immediately stream and decode webm in all modern browsers.
  // MP4 from MediaRecorder frequently produces fragmented mp4 or codecs that
  // browsers fail to play back unless transcode-muxed.
  const candidates: Array<{ mimeType: string; ext: string }> = [
    { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=h264,opus", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
    { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
    { mimeType: "video/mp4", ext: "mp4" },
  ];

  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported?.(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "video/webm", ext: "webm" };
}

export interface RecordingStreams {
  screen: MediaStream | null;
  camera: MediaStream | null;
}

export async function getScreenStream(): Promise<MediaStream> {
  return await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 } as MediaTrackConstraints,
    audio: true,
  });
}

export async function getCameraStream(): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  });
}

/** Capture a JPEG thumbnail data URL from a video/canvas element. */
export function captureThumb(video: HTMLVideoElement): string {
  // drawImage throws InvalidStateError if the element has no decoded frame
  // yet (readyState < HAVE_CURRENT_DATA). Bail out instead of throwing — a
  // missing thumbnail must never break the recording stop flow.
  if (!video || video.readyState < 2 || !video.videoWidth) return "";
  const canvas = document.createElement("canvas");
  const w = video.videoWidth;
  const h = video.videoHeight;
  const scale = Math.min(1, 480 / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return "";
  }
}

export function sourceTypeLabel(t: SourceType): string {
  return t === "screen" ? "Screen" : t === "camera" ? "Camera" : "Screen + Cam";
}

/**
 * Validate that a finalized recording blob is plausible before treating it as
 * a playable recording. A zero-size blob or one built from no chunks is not a
 * real recording — saving it as valid is what produced unplayable "videos".
 */
export function validateRecordingBlob(
  blob: Blob,
  mime: string,
  chunkCount: number,
): { ok: boolean; reason: string } {
  if (chunkCount === 0) {
    return { ok: false, reason: "No media data was captured (0 chunks)." };
  }
  if (!blob || blob.size === 0) {
    return { ok: false, reason: "Recorded blob is empty (0 bytes)." };
  }
  if (!mime || !mime.startsWith("video/")) {
    return { ok: false, reason: `Unsupported recording MIME type: ${mime}` };
  }
  // A real screen recording is at least tens of KB; anything tiny is almost
  // certainly a single static frame / truncated capture.
  if (blob.size < 1024) {
    return { ok: false, reason: `Recording too small (${blob.size} bytes) to be valid.` };
  }
  return { ok: true, reason: "" };
}

/**
 * Best-effort check that the browser's media engine can actually decode the
 * finalized blob. This catches truncated/corrupt WebM output before we tell
 * the user the recording is playable. Never blocks longer than `timeoutMs`;
 * a timeout resolves `false` (treated as "could not verify") rather than
 * hanging the save flow.
 */
export function canDecodeBlob(blob: Blob, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(false);
    let settled = false;
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    v.onloadeddata = () => done(true);
    v.oncanplay = () => done(true);
    v.onerror = () => done(false);
    setTimeout(() => done(false), timeoutMs);
    v.src = url;
  });
}
