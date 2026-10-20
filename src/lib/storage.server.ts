import type {
  Comment,
  Folder,
  FolderOpResult,
  MoveResult,
  Reaction,
  StorageStatus,
  Transcript,
  VideoRecord,
} from "./types";

/**
 * Server-only Supabase Storage helpers.
 *
 * Env read inside each function (call-time injection). The bucket name may
 * contain spaces, so it is URL-encoded in every storage path.
 *
 * Folders are stored as independent objects at `folders/<id>.json` so that
 * concurrent create/delete cannot clobber each other (a single
 * `folders.json` whole-list overwrite is racy). A legacy `folders.json` is
 * migrated on first read. Video moves only rewrite `meta/<id>.json` — the
 * video binary is never touched.
 */

const NOT_CONFIGURED_MSG =
  "Cloud storage is not configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_BUCKET.";

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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Network error";
}

function notConfiguredFolder(): FolderOpResult {
  return { ok: false, error: "not_configured", message: NOT_CONFIGURED_MSG };
}

function notConfiguredMove(): MoveResult {
  return { ok: false, error: "not_configured", message: NOT_CONFIGURED_MSG };
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

/** Run async work over `items` with at most `limit` in flight. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        ret[idx] = await fn(items[idx]!, idx);
      } catch {
        ret[idx] = undefined as unknown as R;
      }
    }
  });
  await Promise.all(workers);
  return ret;
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

/**
 * Create a short-lived signed upload URL for a video object. The browser
 * uploads the blob DIRECTLY to Cloud Storage via this URL — the large binary
 * never passes through the Edge worker (base64-over-RPC hits the worker's
 * payload limit for any real recording and times out, which is why every
 * save showed "Cloud not reachable" / local-only). The server authorizes the
 * upload with the service role key; the browser just PUTs bytes.
 */
export async function createUploadUrl(
  id: string,
  ext: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!configured()) return { ok: false, error: NOT_CONFIGURED_MSG };
  const { url, bucket } = env();
  const objectPath = `videos/${id}.${ext}`;
  try {
    const res = await sbFetch(
      `/storage/v1/object/upload/sign/${encodeBucket(bucket)}/${encodeURIComponent(objectPath)}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `sign failed: ${res.status} ${text}` };
    }
    const data = (await res.json()) as { signed_url?: string; url?: string };
    const signed = data.signed_url ?? data.url;
    if (!signed) return { ok: false, error: "No signed URL in response." };
    // signed_url may be relative ("/storage/v1/...") or absolute.
    const full = signed.startsWith("http")
      ? signed
      : `${url}${signed.startsWith("/") ? "" : "/"}${signed}`;
    return { ok: true, url: full };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function listVideos(): Promise<VideoRecord[]> {
  if (!configured()) return [];
  try {
    const names = await listObjects("meta/");
    const jsons = names.filter((n) => n.endsWith(".json"));
    const recs = await pool(jsons, 6, (n) => downloadJson<VideoRecord>(`meta/${n}`));
    return recs
      .filter((r): r is VideoRecord => !!r && typeof r.id === "string")
      .sort((a, b) => b.createdAt - a.createdAt);
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

/**
 * Check whether a recording's video binary actually exists in Cloud Storage,
 * independent of its metadata. Returns { exists, size } so the client can
 * detect a pre-`localOnly` recording whose metadata was saved but whose
 * binary upload failed (the old base64-over-RPC timeout path) and offer a
 * recovery/retry from the local IndexedDB blob. `size` is the object's
 * content-length when available.
 */
export async function checkVideoObject(
  id: string,
  ext: string,
): Promise<{ exists: boolean; size: number | null; configured: boolean }> {
  if (!configured()) return { exists: false, size: null, configured: false };
  const { url, bucket } = env();
  const objectPath = `videos/${id}.${ext}`;
  try {
    const res = await sbFetch(
      `/storage/v1/object/${encodeBucket(bucket)}/${encodeURIComponent(objectPath)}`,
      { method: "HEAD" },
    );
    if (res.status === 404 || res.status === 400) {
      return { exists: false, size: null, configured: true };
    }
    if (!res.ok) {
      // Treat other errors as "unknown" — don't claim missing.
      return { exists: true, size: null, configured: true };
    }
    const len = res.headers.get("content-length");
    return {
      exists: true,
      size: len ? Number(len) : null,
      configured: true,
    };
  } catch {
    // Network failure — don't claim missing; let playback attempt proceed.
    return { exists: true, size: null, configured: true };
  }
}

/* ---- Folders (independent objects + legacy migration) ---- */

export async function listFolders(): Promise<Folder[]> {
  if (!configured()) return [];
  try {
    const names = await listObjects("folders/");
    const jsons = names.filter((n) => n.endsWith(".json"));
    if (jsons.length > 0) {
      const recs = await pool(jsons, 6, (n) => downloadJson<Folder>(`folders/${n}`));
      return recs
        .filter((f): f is Folder => !!f && typeof f.id === "string" && typeof f.name === "string")
        .sort((a, b) => a.createdAt - b.createdAt);
    }
    // Legacy migration: read the old whole-list file once and split it.
    const legacy = await downloadJson<Folder[]>("folders.json");
    if (Array.isArray(legacy) && legacy.length > 0) {
      await Promise.all(
        legacy.map((f) =>
          uploadJson(`folders/${f.id}.json`, f).catch(() => {
            /* best-effort migration */
          }),
        ),
      );
      return legacy
        .filter((f) => typeof f.id === "string" && typeof f.name === "string")
        .sort((a, b) => a.createdAt - b.createdAt);
    }
    return [];
  } catch {
    return [];
  }
}

export async function saveFolders(folders: Folder[]): Promise<void> {
  if (!configured()) return;
  await uploadJson("folders.json", folders);
}

export async function createFolder(id: string, name: string): Promise<FolderOpResult> {
  if (!configured()) return notConfiguredFolder();
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: "invalid_input", message: "Folder name is required." };
  }
  if (trimmed.length > 100) {
    return {
      ok: false,
      error: "invalid_input",
      message: "Folder name must be 100 characters or fewer.",
    };
  }
  const folder: Folder = { id, name: trimmed, createdAt: Date.now() };
  try {
    await uploadJson(`folders/${id}.json`, folder);
    return { ok: true, folder };
  } catch (e) {
    return { ok: false, error: "transport", message: errMsg(e) };
  }
}

export async function deleteFolder(id: string): Promise<FolderOpResult> {
  if (!configured()) return notConfiguredFolder();
  try {
    // Remove the folder object (best-effort — it may already be gone).
    try {
      await removeObject(`folders/${id}.json`);
    } catch {
      /* ignore */
    }
    // Preserve its recordings by clearing their folder assignment.
    const names = await listObjects("meta/");
    const jsons = names.filter((n) => n.endsWith(".json"));
    const owned = await pool(jsons, 6, (n) => downloadJson<VideoRecord>(`meta/${n}`));
    for (const rec of owned) {
      if (rec && rec.folderId === id) {
        try {
          await uploadJson(`meta/${rec.id}.json`, { ...rec, folderId: null });
        } catch {
          /* best-effort */
        }
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "transport", message: errMsg(e) };
  }
}

/* ---- Video moves (metadata only — never touches the binary) ---- */

export async function moveVideo(videoId: string, folderId: string | null): Promise<MoveResult> {
  if (!configured()) return notConfiguredMove();
  try {
    if (folderId !== null) {
      const dest = await downloadJson<Folder>(`folders/${folderId}.json`);
      if (!dest) {
        return {
          ok: false,
          error: "invalid_folder",
          message: "Destination folder no longer exists.",
        };
      }
    }
    const rec = await downloadJson<VideoRecord>(`meta/${videoId}.json`);
    if (!rec) {
      return {
        ok: false,
        error: "not_found",
        message: "Recording not found in cloud storage.",
      };
    }
    const updated: VideoRecord = { ...rec, folderId };
    await uploadJson(`meta/${videoId}.json`, updated);
    return { ok: true, record: updated };
  } catch (e) {
    return { ok: false, error: "transport", message: errMsg(e) };
  }
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
