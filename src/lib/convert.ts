// Browser-side WebM -> MP4 (H.264 + AAC) transcode via ffmpeg.wasm, loaded from
// a CDN at runtime. The Edge worker cannot spawn native FFmpeg, so a genuine
// seekable MP4 is produced in the browser (ffmpeg.wasm spawns its own Web
// Worker, so the main thread is not blocked), cached in IndexedDB, and uploaded
// as a derivative under videos/<id>.mp4. The original WebM is never touched.
//
// The ~32MB ffmpeg core is loaded from a CDN with /* @vite-ignore */ on a
// variable specifier so it is never bundled (the Edge deploy has a ~25MB
// per-asset limit and onnxruntime/ffmpeg must not ship in the client bundle).

export interface ConvertProgress {
  pct: number;
  msg: string;
}

interface FFmpegAPI {
  load: (config: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<boolean>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  exec: (args: string[], timeout?: number, opts?: { signal?: AbortSignal }) => Promise<number>;
  readFile: (path: string, encoding?: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<void>;
  terminate: () => void;
  on: (event: "log" | "progress", cb: (data: unknown) => void) => void;
  loaded: boolean;
}

type FFmpegModule = { FFmpeg: new () => FFmpegAPI };

const FFMPEG_PKG = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.9/dist/esm";

let ffmpegPromise: Promise<FFmpegAPI> | null = null;

async function loadFFmpeg(): Promise<FFmpegAPI> {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const mod = (await import(/* @vite-ignore */ FFMPEG_PKG)) as FFmpegModule;
    const ffmpeg = new mod.FFmpeg();
    await ffmpeg.load({
      coreURL: `${CORE_BASE}/ffmpeg-core.js`,
      wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
    });
    return ffmpeg;
  })();
  // If the first load fails, clear the cache so a later retry can try again.
  ffmpegPromise.catch(() => {
    ffmpegPromise = null;
  });
  return ffmpegPromise;
}

/**
 * Convert a recording blob (WebM/VP8/VP9+Opus, or any browser-recorded container)
 * into a finalized, seekable MP4 with H.264 video (yuv420p) and AAC audio when
 * an audio track exists. Uses +faststart so the moov atom is written up front
 * and the file is seekable in VLC / QuickTime / Windows Media. Forces a
 * keyframe every ~2s for practical random access.
 */
export async function convertBlobToMp4(
  input: Blob,
  onProgress?: (p: ConvertProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  onProgress?.({ pct: 2, msg: "Loading converter…" });
  const ffmpeg = await loadFFmpeg();

  const progressHandler = (data: unknown) => {
    const d = data as { progress?: number };
    if (typeof d?.progress === "number" && Number.isFinite(d.progress)) {
      const pct = Math.max(5, Math.min(95, Math.round(d.progress * 100)));
      onProgress?.({ pct, msg: "Converting to MP4…" });
    }
  };
  ffmpeg.on("progress", progressHandler);

  const inName = "in.webm";
  const outName = "out.mp4";

  const bytes = new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Recording is empty (0 bytes).");
  await ffmpeg.writeFile(inName, bytes);
  onProgress?.({ pct: 6, msg: "Converting to MP4…" });

  // -map 0:a:0? is an optional map: if there is no audio track, it is skipped
  // instead of failing. -an is not used so real audio is preserved.
  const args = [
    "-i",
    inName,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outName,
  ];

  const code = await ffmpeg.exec(args, 300000, signal ? { signal } : undefined);
  if (code !== 0) {
    throw new Error(
      "MP4 conversion failed. The recording may be empty or use an unsupported codec.",
    );
  }

  const out = await ffmpeg.readFile(outName);
  try {
    await ffmpeg.deleteFile(inName);
  } catch {
    /* best-effort */
  }
  try {
    await ffmpeg.deleteFile(outName);
  } catch {
    /* best-effort */
  }

  if (typeof out === "string" || out.byteLength === 0) {
    throw new Error("Conversion produced an empty or invalid file.");
  }
  // Copy into a fresh ArrayBuffer so the Blob is backed by a real ArrayBuffer
  // (not the worker's possibly-shared buffer) — keeps TS BlobPart typing happy
  // and avoids any detached-ArrayBuffer edge case.
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  const blob = new Blob([ab], { type: "video/mp4" });
  if (!blob.size || blob.size < 1024) {
    throw new Error("Conversion produced an empty or invalid file.");
  }
  onProgress?.({ pct: 100, msg: "Done" });
  return blob;
}

/** Drop the converter worker to free memory. Safe to call repeatedly. */
export function unloadFFmpeg(): void {
  if (ffmpegPromise) {
    const p = ffmpegPromise;
    ffmpegPromise = null;
    p.then(
      (f) => {
        try {
          f.terminate();
        } catch {
          /* ignore */
        }
      },
      () => {},
    );
  }
}
