import type { TranscriptSegment } from "./types";

/**
 * Transcribe a video in-browser using Whisper via @huggingface/transformers,
 * loaded from the jsDelivr CDN bundle at runtime (so the ~150MB model + onnx
 * runtime are never bundled into the client). Returns timestamped segments.
 */
export async function transcribeVideo(
  mediaUrl: string,
  onProgress?: (pct: number, msg: string) => void,
): Promise<TranscriptSegment[]> {
  onProgress?.(0, "Loading model…");
  // Bundled jsDelivr build; avoids the esm.sh onnxruntime-web Node build.
  // Specifier kept in a variable so the bundler never statically resolves it.
  const cdnUrl = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.4";
  const mod = (await import(/* @vite-ignore */ cdnUrl)) as {
    env: { allowLocalModels?: boolean; useBrowserCache?: boolean };
    pipeline: (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<(input: string, options?: Record<string, unknown>) => Promise<unknown>>;
  };
  const { pipeline, env } = mod;
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-base", {
    device: "wasm",
  });

  onProgress?.(20, "Transcribing…");
  const output = (await asr(mediaUrl, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  })) as {
    text: string;
    chunks?: Array<{ timestamp: [number, number]; text: string }>;
  };

  const chunks = output.chunks ?? [];
  const segments: TranscriptSegment[] = chunks.map((c) => ({
    start: c.timestamp[0] ?? 0,
    end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 1,
    text: c.text.trim(),
  }));

  // Merge tiny adjacent segments for readability.
  const merged: TranscriptSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && seg.start - last.end < 0.4) {
      last.end = seg.end;
      last.text = `${last.text} ${seg.text}`.trim();
    } else {
      merged.push({ ...seg });
    }
  }
  onProgress?.(100, "Done");
  return merged;
}
