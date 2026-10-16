import type { SourceType } from "./types";

/**
 * Choose a MediaRecorder mimeType the browser supports, preferring MP4
 * (avc1/mp4a) over WebM (vp9/opus, vp8/opus, h264/opus, plain webm).
 */
export function pickMimeType(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === "undefined") {
    return { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" };
  }
  const candidates: Array<{ mimeType: string; ext: string }> = [
    { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
    { mimeType: "video/mp4", ext: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=h264,opus", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
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
