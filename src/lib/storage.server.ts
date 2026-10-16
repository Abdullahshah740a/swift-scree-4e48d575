import type { Comment, Folder, Reaction, StorageStatus, Transcript, VideoRecord } from "./types";

/**
 * Server-only Supabase Storage helpers.
 *
 * Env read inside each function (call-time injection). The bucket name may
 * contain spaces, so it is URL-encoded in every storage path.
 */

function env() {
  return {
    url: process.env["SUPABASE_URL"] ?? "",
    key: process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "",
    bucket: process.env["SUPABASE_BUCKET"] ?? "",
  };
}

function configured(): boolean {
  const { url, key, bucket } = env();
  return Boolean(url && key && bucket);
}

async function sbFetch(path: string, init: RequestInit = {}, ms = 9000): Promise<Response> {
  const { url, key } = env();
  if (!url || !key) throw new Error("Supabase not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(init.headers ?? {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function encodeBucket(bucket: string): string {
  return encodeURIComponent(bucket);
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const { bucket } = env();
  const base: StorageStatus = {
    configured: configured(),
    reachable: false,
    bucketMatch: false,
    expectedBucket: bucket,
    buckets: [],
    error: null,
  };
  if (!base.configured) {
    return {
      ...base,
      error: "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_BUCKET.",
    };
  }
  try {
    const res = await sbFetch("/storage/v1/bucket", { method: "GET" });
    if (!res.ok) {
      return { ...base, error: `Storage API ${res.status}` };
    }
    const data = (await res.json()) as { name?: string }[];
    const buckets = Array.isArray(data) ? data.map((b) => b.name ?? "") : [];
    return {
      ...base,
      reachable: true,
      bucketMatch: buckets.includes(bucket),
      buckets,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : "Unreachable" };
  }
}

async function listObjects(prefix: string): Promise<string[]> {
  const { bucket } = env();
  const res = await sbFetch(`/storage/v1/object/list/${encodeBucket(bucket)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  if (!res.ok) throw new Error(`list ${prefix} failed: ${res.status}`);
  const data = (await res.json()) as { name: string }[];
  return data.map((o) => o.name);
}

async function downloadJson<T>(path: string): Promise<T | null> {
  const { bucket } = env();
  const res = await sbFetch(
    `/storage/v1/object/${encodeBucket(bucket)}/${encodeURIComponent(path)}`,
    { method: "GET" },
  );
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function uploadJson(path: string, json: unknown): Promise<void> {
  const { bucket } = env();
  const res = await sbFetch(
    `/storage/v1/object/${encodeBucket(bucket)}/${encodeURIComponent(path)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-upsert": "true" },
      body: JSON.stringify(json),
    },
  );
  if (!res.ok) throw new Error(`upload ${path} failed: ${res.status}`);
}

async function uploadBytes(path: string, bytes: Uint8Array, mime: string): Promise<void> {
  const { bucket } = env();
  const res = await sbFetch(
    `/storage/v1/object/${encodeBucket(bucket)}/${encodeURIComponent(path)}`,
    {
      method: "POST",
      headers: { "Content-Type": mime, "x-upsert": "true" },
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    },
  );
  if (!res.ok) throw new Error(`upload ${path} failed: ${res.status}`);
}

async function removeObject(path: string): Promise<void> {
  const { bucket } = env();
  const res = await sbFetch(
    `/storage/v1/object/${encodeBucket(bucket)}/${encodeURIComponent(path)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`delete ${path} failed: ${res.status}`);
}

/* ---- Videos ---- */

export async function listVideos(): Promise<VideoRecord[]> {
  if (!configured()) return [];
  try {
    const names = await listObjects("meta/");
    const records: VideoRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const rec = await downloadJson<VideoRecord>(`meta/${name}`);
      if (rec) records.push(rec);
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function getVideoMeta(id: string): Promise<VideoRecord | null> {
  if (!configured()) return null;
  try {
    return await downloadJson<VideoRecord>(`meta/${id}.json`);
  } catch {
    return null;
  }
}

export async function saveVideoMeta(rec: VideoRecord): Promise<void> {
  if (!configured()) return;
  await uploadJson(`meta/${rec.id}.json`, rec);
}

export interface UploadVideoInput {
  record: VideoRecord;
  base64: string; // data URL or raw base64
}

export async function uploadVideo(input: UploadVideoInput): Promise<void> {
  if (!configured()) return;
  const { record, base64 } = input;
  const raw = base64.includes(",") ? (base64.split(",")[1] ?? "") : base64;
  const bin = Buffer.from(raw, "base64");
  const bytes = new Uint8Array(bin);
  await uploadBytes(`videos/${record.id}.${record.ext}`, bytes, record.mimeType);
  await saveVideoMeta(record);
}

export async function deleteVideo(id: string, ext: string): Promise<void> {
  if (!configured()) return;
  try {
    await removeObject(`videos/${id}.${ext}`);
  } catch {
    /* ignore */
  }
  try {
    await removeObject(`meta/${id}.json`);
  } catch {
    /* ignore */
  }
}

/* ---- Folders ---- */

export async function listFolders(): Promise<Folder[]> {
  if (!configured()) return [];
  try {
    const data = await downloadJson<Folder[]>("folders.json");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveFolders(folders: Folder[]): Promise<void> {
  if (!configured()) return;
  await uploadJson("folders.json", folders);
}

/* ---- Comments ---- */

export async function listComments(videoId: string): Promise<Comment[]> {
  if (!configured()) return [];
  try {
    const data = await downloadJson<Comment[]>(`comments/${videoId}.json`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveComments(videoId: string, comments: Comment[]): Promise<void> {
  if (!configured()) return;
  await uploadJson(`comments/${videoId}.json`, comments);
}

/* ---- Reactions ---- */

export async function listReactions(videoId: string): Promise<Reaction[]> {
  if (!configured()) return [];
  try {
    const data = await downloadJson<Reaction[]>(`reactions/${videoId}.json`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveReactions(videoId: string, reactions: Reaction[]): Promise<void> {
  if (!configured()) return;
  await uploadJson(`reactions/${videoId}.json`, reactions);
}

/* ---- Transcript ---- */

export async function getTranscript(videoId: string): Promise<Transcript | null> {
  if (!configured()) return null;
  try {
    return await downloadJson<Transcript>(`transcript/${videoId}.json`);
  } catch {
    return null;
  }
}

export async function saveTranscript(transcript: Transcript): Promise<void> {
  if (!configured()) return;
  await uploadJson(`transcript/${transcript.videoId}.json`, transcript);
}
