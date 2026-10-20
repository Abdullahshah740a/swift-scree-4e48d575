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
/**
 * Choose a MediaRecorder mimeType the browser can actually ENCODE for the
 * given stream. The codec string MUST match the stream's tracks: a video-only
 * screen capture (no system audio) recorded with `video/webm;codecs=vp9,opus`
 * can produce ZERO output chunks in some Chrome builds because the Opus audio
 * codec has no source track — which is exactly the "No media data was
 * captured (0 chunks)" failure. So when there's no audio track we pick a
 * video-only codec string (`codecs=vp9`, no opus); when there is audio we
 * include opus. WebM (VP9/VP8) is prioritized; MP4 is a last-resort fallback
 * (Safari). The caller still reads `MediaRecorder.mimeType` after construction
 * for the real container/codec actually in use.
 */
export function pickMimeType(hasAudio = true): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === "undefined") {
    return { mimeType: "video/webm", ext: "webm" };
  }

  // Try each video codec with (or without) an Opus audio codec depending on
  // whether the stream actually carries audio. The bare `video/webm` entry
  // lets the browser pick codecs itself if the explicit strings are rejected.
  const videoCodecs = ["vp9", "vp8", "h264", ""] as const;
  const candidates: Array<{ mimeType: string; ext: string }> = [];
  for (const v of videoCodecs) {
    const codec = v ? (hasAudio ? `${v},opus` : v) : "";
    candidates.push({
      mimeType: codec ? `video/webm;codecs=${codec}` : "video/webm",
      ext: "webm",
    });
  }
  candidates.push({ mimeType: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" });
  candidates.push({ mimeType: "video/mp4", ext: "mp4" });

  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported?.(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "video/webm", ext: "webm" };
}

/**
 * Construct a MediaRecorder whose codec string matches the stream's actual
 * tracks. A video-only screen capture (no audio) recorded with an Opus audio
 * codec can produce 0 output chunks in some Chrome builds — the root cause of
 * "No media data was captured (0 chunks)". This picks a video-only codec when
 * there's no audio, falls back to the browser default if the preferred codec
 * is rejected, and returns the recorder plus its real `mimeType` (always read
 * from the instance, never assumed).
 */
export function createRecorder(
  stream: MediaStream,
  videoBitsPerSecond = 4_000_000,
): { recorder: MediaRecorder; mimeType: string } {
  const hasAudio = stream.getAudioTracks().length > 0;
  const preferred = pickMimeType(hasAudio);
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: preferred.mimeType, videoBitsPerSecond });
  } catch {
    try {
      rec = new MediaRecorder(stream, { videoBitsPerSecond });
    } catch {
      rec = new MediaRecorder(stream);
    }
  }
  return { recorder: rec, mimeType: rec.mimeType || preferred.mimeType };
}

export interface RecordingStreams {
  screen: MediaStream | null;
  camera: MediaStream | null;
  mic: MediaStream | null;
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

/** Capture the microphone for a voiceover track (screen + both modes). */
export async function getMicStream(): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

export interface MixedAudio {
  track: MediaStreamTrack;
  /** Only present when 2+ sources were mixed via Web Audio; close on stop. */
  context?: AudioContext;
}

/**
 * Combine one or more live audio tracks into a single MediaStreamTrack.
 * - 0 live tracks -> null (no audio; recorder uses a video-only codec)
 * - 1 live track  -> returned as-is (no mixing needed)
 * - 2+ live tracks -> mixed through a Web Audio MediaStreamDestination so the
 *   recorder gets exactly one Opus track. MediaRecorder only reliably records
 *   one audio track per stream, so an unmixed multi-track stream loses
 *   everything but the first track. The returned context must be closed when
 *   recording stops.
 */
export function mixAudioTracks(tracks: MediaStreamTrack[]): MixedAudio | null {
  const live = tracks.filter((t) => t.readyState === "live");
  const first = live[0];
  if (live.length === 0 || !first) return null;
  if (live.length === 1) return { track: first };
  const Ctor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return { track: first };
  const ctx = new Ctor();
  const dest = ctx.createMediaStreamDestination();
  for (const t of live) {
    try {
      ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    } catch {
      /* skip a track Web Audio can't bind */
    }
  }
  const out = dest.stream.getAudioTracks()[0];
  if (!out) {
    ctx.close().catch(() => {});
    return { track: first };
  }
  return { track: out, context: ctx };
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
