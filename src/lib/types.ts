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
  storagePath?: string; // videos/<id>.<ext> (original)
  /**
   * Converted MP4 derivative (H.264/AAC, +faststart). Produced on demand by
   * the browser (ffmpeg.wasm) and uploaded under videos/<id>.mp4 so the same
   * seekable MP4 is reused for every subsequent "Download MP4" and on other
   * devices. The original recording fields above are never overwritten by it.
   */
  mp4Path?: string; // videos/<id>.mp4
  mp4Size?: number; // bytes of the converted MP4
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
