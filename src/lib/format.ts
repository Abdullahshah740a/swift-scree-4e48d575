import type { SourceType } from "./types";
import type { SyncDiagnostics } from "./types";

/**
 * Render a SyncDiagnostics record as a plain, copyable diagnostic text block
 * the user can paste back. Contains NO credentials, signed tokens, auth
 * headers, or video bytes — only sanitized correlation metadata. When
 * `fetch` failed before any response, httpStatus stays null and we say so
 * explicitly (we never invent an HTTP status or call it a storage rejection).
 */
export function diagnosticsToText(d: SyncDiagnostics): string {
  const lines = [
    `Swift Screen — cloud sync diagnostic`,
    `Recording ID: ${d.recordingId}`,
    `Stage: ${d.stage}${d.failed ? " (failed)" : ""}`,
    `Blob size: ${d.blobSize} bytes (${d.blobSizeMb})`,
    `MIME type: ${d.mimeType}`,
    `Extension: ${d.ext}`,
    `Started at: ${d.startedAt}`,
    `Elapsed: ${d.elapsedMs === null ? "unknown" : `${d.elapsedMs} ms`}`,
    `HTTP status: ${d.httpStatus === null ? "no response (fetch failed before any HTTP response)" : d.httpStatus}`,
    `Error kind: ${d.errorKind}`,
    `Error message: ${d.errorMessage ?? "none"}`,
    `Error name: ${d.rawName ?? "none"}`,
  ];
  return lines.join("\n");
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 60) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function extFromMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  return "webm";
}

export function sourceTypeLabel(t: SourceType): string {
  switch (t) {
    case "screen":
      return "Screen";
    case "camera":
      return "Camera";
    case "both":
      return "Screen + Cam";
  }
}
