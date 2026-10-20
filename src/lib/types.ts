export type SourceType = "screen" | "camera" | "both";

export interface VideoRecord {
  id: string;
  title: string;
  description?: string;
  author: string;
  mimeType: string;
  ext: string;
  duration: number; // seconds
  size: number; // bytes
  sourceType: SourceType;
  thumbnail: string; // data URL
  folderId?: string | null;
  views: number;
  createdAt: number;
  storagePath?: string; // videos/<id>.<ext>
  /**
   * True when the recording's bytes are only in this browser's IndexedDB —
   * the cloud upload did not succeed (transport/payload/CORS failure). The
   * library/watch UI surfaces this so the user knows the shared link won't
   * work and can retry the sync. NOT set for confirmed cloud recordings.
   */
  localOnly?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Comment {
  id: string;
  videoId: string;
  author: string;
  text: string;
  time: number; // seconds
  createdAt: number;
}

export interface Reaction {
  id: string;
  videoId: string;
  emoji: string;
  author: string;
  time: number; // seconds
  createdAt: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  videoId: string;
  segments: TranscriptSegment[];
  generatedAt: number;
}

export interface StorageStatus {
  configured: boolean;
  reachable: boolean;
  bucketMatch: boolean;
  expectedBucket: string;
  buckets: string[];
  error: string | null;
}

/**
 * Discriminated result for folder/move mutations. The server returns a plain
 * DTO (never throws for expected conditions) so the client can distinguish
 * "not configured", "not found", "invalid folder", and transport failures
 * instead of swallowing them into a success-shaped fallback.
 */
export type OpError =
  "not_configured" | "not_found" | "invalid_folder" | "invalid_input" | "conflict" | "transport";

export interface FolderOpResult {
  ok: boolean;
  error?: OpError;
  message?: string;
  folder?: Folder;
}

export interface MoveResult {
  ok: boolean;
  error?: OpError;
  message?: string;
  record?: VideoRecord | null;
  /** True when only the local IndexedDB cache was updated (no cloud write). */
  localOnly?: boolean;
}

/**
 * Result of verifying a recording's video binary in Cloud Storage,
 * independent of its metadata. `status` is explicit so the client never has
 * to infer verification from a network failure:
 *   - "present": storage returned a HEAD 2xx for the object path.
 *   - "missing": storage returned 404 (object not found) — the ONLY status
 *     that proves the object is absent. Other 4xx (400, 403, …) are
 *     auth/path errors, not missing-object proof, and map to "unknown".
 *   - "unknown": any other non-ok response OR a network/transport failure.
 *     The recording stays visible (it may exist) but is NOT claimed as
 *     verified in cloud storage; the check may be retried.
 * `size` is the object's content-length when available (best-effort
 * byte-size comparison against the source Blob). `error` preserves
 * diagnostic detail for non-present cases.
 */
export type VideoObjectStatus = "present" | "missing" | "unknown";

export interface VideoObjectCheck {
  status: VideoObjectStatus;
  size: number | null;
  configured: boolean;
  error?: string;
}
