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
