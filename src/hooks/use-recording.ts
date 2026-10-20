import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  captureThumb,
  createRecorder,
  getCameraStream,
  getMicStream,
  getScreenStream,
  mixAudioTracks,
  validateRecordingBlob,
  type RecordingStreams,
} from "@/lib/media";
import { extFromMime } from "@/lib/format";
import { persistVideoMeta } from "@/lib/storage-client";
import { finalizeAndSaveRecording } from "@/lib/recording-save";
import { repairWebmDuration } from "@/lib/webm-duration";
import { toast } from "sonner";
import type { SourceType, VideoRecord } from "@/lib/types";

export type RecordingPhase = "idle" | "recording" | "finalizing" | "saving" | "stopped";

export interface StartOptions {
  source: SourceType;
  author: string;
}

export interface UpdateDetailsOptions {
  title: string;
  description: string;
  source: SourceType;
  author: string;
}

export interface RecordingEngine {
  phase: RecordingPhase;
  paused: boolean;
  elapsed: number;
  error: string | null;
  previewUrl: string | null;
  savedId: string | null;
  savedLocalOnly: boolean;
  saveMsg: string | null;
  chosenMime: string;
  start: (opts: StartOptions) => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  updateDetails: (opts: UpdateDetailsOptions) => Promise<void>;
}

/**
 * MediaRecorder lifecycle engine. Owns every recorder ref, the chunk array,
 * stream cleanup, mic + audio mixing, pause/resume timing, the onstop-authoritative
 * finalize flow, and the save/upload. The route component is a thin UI caller.
 */
export function useRecordingEngine(qc: QueryClient): RecordingEngine {
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedLocalOnly, setSavedLocalOnly] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [chosenMime, setChosenMime] = useState("video/webm");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamsRef = useRef<RecordingStreams>({ screen: null, camera: null, mic: null });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const chosenMimeRef = useRef<string>("video/webm");
  const blobRef = useRef<Blob | null>(null);
  const thumbRef = useRef<string>("");
  const durationRef = useRef<number>(0);
  const startedAtRef = useRef<number>(0);
  const baseElapsedRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);
  const finalizeStartedRef = useRef<boolean>(false);
  const stopRequestedRef = useRef<boolean>(false);
  const safetyTimerRef = useRef<number | null>(null);
  const recorderErrorRef = useRef<string | null>(null);
  const sourceRef = useRef<SourceType>("screen");
  const authorRef = useRef<string>("");

  // Hidden <video> elements MUST be in the DOM or browsers won't decode and
  // the composite "both" recording is a static frame. They're also used to
  // capture thumbnails in every mode.
  useEffect(() => {
    screenVideoRef.current = document.createElement("video");
    screenVideoRef.current.muted = true;
    screenVideoRef.current.playsInline = true;
    screenVideoRef.current.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;";
    document.body.appendChild(screenVideoRef.current);

    camVideoRef.current = document.createElement("video");
    camVideoRef.current.muted = true;
    camVideoRef.current.playsInline = true;
    camVideoRef.current.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;";
    document.body.appendChild(camVideoRef.current);

    return () => {
      [screenVideoRef.current, camVideoRef.current].forEach((v) => {
        if (v?.parentElement) v.parentElement.removeChild(v);
      });
    };
  }, []);

  // Elapsed timer — freezes while paused so the clock reflects real recorded time.
  useEffect(() => {
    if (phase !== "recording") return;
    if (paused) {
      setElapsed(baseElapsedRef.current);
      return;
    }
    const tick = () =>
      setElapsed(baseElapsedRef.current + (Date.now() - startedAtRef.current) / 1000);
    timerRef.current = window.setInterval(tick, 200);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase, paused]);

  const stopAllStreams = useCallback(() => {
    streamsRef.current.screen?.getTracks().forEach((t) => t.stop());
    streamsRef.current.camera?.getTracks().forEach((t) => t.stop());
    streamsRef.current.mic?.getTracks().forEach((t) => t.stop());
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamsRef.current = { screen: null, camera: null, mic: null };
    streamRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }, []);

  // SINGLE authoritative finalize path, called only from onstop. The safety
  // net never builds a blob — it only calls rec.stop() so onstop fires. onerror
  // never finalizes — it records the error and lets onstop complete. Idempotent.
  //
  // IMPORTANT (Chrome compatibility): Chrome's MediaRecorder emits a "live"
  // WebM whose EBML Duration element is left unset. Firefox tolerates that;
  // Chrome does not — Chrome reports a decode error and never fires
  // loadedmetadata, which is exactly the "plays in Firefox, not Chrome"
  // regression. We repair the container (pure-JS EBML patch, no transcode)
  // with the real recorded duration BEFORE validating / previewing / saving,
  // so the local blob, the cloud upload, AND the immediate preview all carry
  // Chrome-compatible bytes.
  const finalizeFromChunks = useCallback(
    async (_reason: "onstop") => {
      if (finalizeStartedRef.current) return;
      finalizeStartedRef.current = true;
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }

      const total = pausedRef.current
        ? baseElapsedRef.current
        : baseElapsedRef.current + (Date.now() - startedAtRef.current) / 1000;
      durationRef.current = total;

      const actualMime = recorderRef.current?.mimeType || chosenMimeRef.current || "video/webm";
      chosenMimeRef.current = actualMime;
      setChosenMime(actualMime);
      const chunkCount = chunksRef.current.length;
      const rawBlob = new Blob(chunksRef.current, { type: actualMime });

      // Repair the WebM container for Chrome before validation/preview/save.
      // Non-WebM (e.g. Safari mp4) is returned untouched.
      let finalBlob = rawBlob;
      try {
        finalBlob = await repairWebmDuration(rawBlob, total * 1000, actualMime);
      } catch (e) {
        console.warn("[record] webm duration repair threw; using original", e);
        finalBlob = rawBlob;
      }

      console.info("[record] finalize", {
        mime: actualMime,
        chunkCount,
        blobSize: finalBlob.size,
        repaired: finalBlob !== rawBlob,
        hadError: Boolean(recorderErrorRef.current),
      });
      const validation = validateRecordingBlob(finalBlob, actualMime, chunkCount);
      if (!validation.ok) {
        stopAllStreams();
        setError(
          recorderErrorRef.current
            ? `Recording failed: ${recorderErrorRef.current}`
            : validation.reason,
        );
        setPhase("idle");
        return;
      }
      blobRef.current = finalBlob;
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(finalBlob);
      });
      let thumbData = "";
      try {
        const thumbEl =
          sourceRef.current === "camera" ? camVideoRef.current : screenVideoRef.current;
        if (thumbEl) {
          thumbData = captureThumb(thumbEl);
          thumbRef.current = thumbData;
        }
      } catch {
        /* thumbnail optional */
      }
      stopAllStreams();
      void finalizeAndSave(finalBlob, total, thumbData);
    },
    [stopAllStreams],
  );

  async function finalizeAndSave(finalBlob: Blob, totalSeconds: number, thumbData: string) {
    setPhase("saving");
    const mimeType = chosenMimeRef.current;
    const result = await finalizeAndSaveRecording(
      finalBlob,
      mimeType,
      chunksRef.current.length,
      totalSeconds,
      { source: sourceRef.current, author: authorRef.current, thumbData },
    );
    if (!result.ok || !result.record) {
      setError(result.reason ?? "Recording could not be saved.");
      setPhase("idle");
      return;
    }
    qc.invalidateQueries({ queryKey: ["videos"] });
    qc.invalidateQueries({ queryKey: ["storage-status"] });
    setSavedLocalOnly(Boolean(result.localOnly));
    setSaveMsg(result.localOnly ? "Saved locally (Cloud not reachable)" : "Saved to Cloud");
    setSavedId(result.record.id);
    toast.success(result.localOnly ? "Saved locally" : "Recording saved");
    setPhase("stopped");
  }

  const start = useCallback(
    async (opts: StartOptions) => {
      const source = opts.source;
      const author = opts.author;
      setError(null);
      chunksRef.current = [];
      blobRef.current = null;
      thumbRef.current = "";
      durationRef.current = 0;
      stopRequestedRef.current = false;
      finalizeStartedRef.current = false;
      recorderErrorRef.current = null;
      sourceRef.current = source;
      authorRef.current = author;
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      setElapsed(0);
      setPaused(false);
      setSavedId(null);
      setSaveMsg(null);
      setChosenMime("video/webm");
      pausedRef.current = false;
      baseElapsedRef.current = 0;

      try {
        let combined: MediaStream;
        let mic: MediaStream | null = null;
        let screenAudioTracks: MediaStreamTrack[] = [];

        if (source === "screen") {
          const s = await getScreenStream();
          streamsRef.current.screen = s;
          screenAudioTracks = s.getAudioTracks();
          // Capture the mic for a voiceover over the screen capture.
          try {
            mic = await getMicStream();
            streamsRef.current.mic = mic;
          } catch {
            /* mic optional — record screen (system) audio only */
          }
          const videoTrack = s.getVideoTracks()[0];
          if (!videoTrack) throw new Error("No video track from screen capture.");
          const streams = [new MediaStream([videoTrack])];
          // Mix system + mic audio into one track for the recorder.
          const mixed = mixAudioTracks([...screenAudioTracks, ...(mic?.getAudioTracks() ?? [])]);
          if (mixed) streams.push(new MediaStream([mixed.track]));
          combined = new MediaStream(streams.flatMap((st) => [...st.getTracks()]));
          const sv = screenVideoRef.current!;
          sv.srcObject = new MediaStream([videoTrack]);
          await sv.play().catch(() => {});
        } else if (source === "camera") {
          const c = await getCameraStream();
          streamsRef.current.camera = c;
          combined = c;
          const cv = camVideoRef.current!;
          cv.srcObject = c;
          await cv.play().catch(() => {});
        } else {
          const s = await getScreenStream();
          streamsRef.current.screen = s;
          screenAudioTracks = s.getAudioTracks();
          let cam: MediaStream | null = null;
          try {
            cam = await getCameraStream();
            streamsRef.current.camera = cam;
          } catch {
            /* camera optional in both; fall back to screen + mic */
          }

          const screenV = screenVideoRef.current!;
          const camV = camVideoRef.current!;
          const screenTrack = s.getVideoTracks()[0];
          if (screenTrack) {
            screenV.srcObject = new MediaStream([screenTrack]);
            await screenV.play().catch(() => {});
          }
          if (cam) {
            camV.srcObject = cam;
            await camV.play().catch(() => {});
          }

          const canvas = document.createElement("canvas");
          canvas.width = 1280;
          canvas.height = 720;
          canvasRef.current = canvas;
          const ctx = canvas.getContext("2d")!;
          const draw = () => {
            if (screenTrack) ctx.drawImage(screenV, 0, 0, canvas.width, canvas.height);
            if (cam && camV.videoWidth) {
              const camW = Math.round(canvas.width * 0.28);
              const camH = Math.round((camV.videoHeight / camV.videoWidth) * camW);
              const px = canvas.width - camW - 24;
              const py = canvas.height - camH - 24;
              ctx.save();
              ctx.fillStyle = "rgba(0,0,0,0.4)";
              ctx.fillRect(px - 6, py - 6, camW + 12, camH + 12);
              ctx.beginPath();
              ctx.roundRect(px, py, camW, camH, 12);
              ctx.clip();
              ctx.drawImage(camV, px, py, camW, camH);
              ctx.restore();
            }
            rafRef.current = requestAnimationFrame(draw);
          };
          rafRef.current = requestAnimationFrame(draw);
          combined = canvas.captureStream(30);
          // Mix system audio + the camera/mic audio into one Opus track.
          const micTracks = cam ? cam.getAudioTracks() : [];
          const mixed = mixAudioTracks([...screenAudioTracks, ...micTracks]);
          if (mixed) combined.addTrack(mixed.track);
        }

        streamRef.current = combined;
        // createRecorder matches the codec string to the stream's actual
        // tracks (video-only codec when no audio) so a silent capture never
        // produces 0 chunks. It returns the recorder's real mimeType.
        const { recorder: rec, mimeType } = createRecorder(combined);
        chosenMimeRef.current = mimeType;
        setChosenMime(mimeType);
        recorderRef.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onerror = (e) => {
          // Record the error but do NOT finalize here — onerror can fire
          // before the final dataavailable chunk. onstop is authoritative.
          const err = (e as unknown as { error?: Error }).error;
          recorderErrorRef.current = err?.message ?? "Recorder error";
          console.warn("[record] MediaRecorder error", recorderErrorRef.current);
          if (rec.state !== "inactive") {
            try {
              rec.stop();
            } catch {
              /* already stopping */
            }
          }
        };
        rec.onstop = () => {
          finalizeFromChunks("onstop");
        };
        // Native "Stop sharing" bar -> treat as a graceful stop.
        combined.getTracks().forEach((t) => {
          t.addEventListener("ended", () => {
            if (
              recorderRef.current &&
              recorderRef.current.state !== "inactive" &&
              !finalizeStartedRef.current
            ) {
              try {
                recorderRef.current.stop();
              } catch {
                /* ignore */
              }
            }
          });
        });
        rec.start(1000);
        startedAtRef.current = Date.now();
        setPhase("recording");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not start recording";
        setError(msg);
        stopAllStreams();
        setPhase("idle");
      }
    },
    [finalizeFromChunks, stopAllStreams],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setPhase("finalizing");
    safetyTimerRef.current = window.setTimeout(() => {
      if (!finalizeStartedRef.current) {
        console.warn("[record] safety net firing");
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          try {
            recorderRef.current.stop();
          } catch {
            /* ignore */
          }
        } else {
          finalizeFromChunks("onstop");
        }
      }
    }, 5000);
    try {
      rec.stop();
    } catch {
      if (!finalizeStartedRef.current) finalizeFromChunks("onstop");
    }
  }, [finalizeFromChunks]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    baseElapsedRef.current += (Date.now() - startedAtRef.current) / 1000;
    rec.pause();
    pausedRef.current = true;
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    startedAtRef.current = Date.now();
    rec.resume();
    pausedRef.current = false;
    setPaused(false);
  }, []);

  const reset = useCallback(() => {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPhase("idle");
    blobRef.current = null;
    thumbRef.current = "";
    finalizeStartedRef.current = false;
    stopRequestedRef.current = false;
    recorderErrorRef.current = null;
    setSavedId(null);
    setSaveMsg(null);
    setElapsed(0);
    setPaused(false);
  }, []);

  const updateDetails = useCallback(
    async (opts: UpdateDetailsOptions) => {
      if (!savedId) return;
      const mimeType = chosenMimeRef.current;
      const ext = extFromMime(mimeType);
      const record: VideoRecord = {
        id: savedId,
        title: opts.title.trim() || `Recording ${new Date().toLocaleString()}`,
        description: opts.description.trim(),
        author: opts.author.trim() || "You",
        mimeType,
        ext,
        duration: Math.round(durationRef.current),
        size: blobRef.current?.size ?? 0,
        sourceType: opts.source,
        thumbnail: thumbRef.current,
        folderId: null,
        views: 0,
        createdAt: Date.now(),
        storagePath: `videos/${savedId}.${ext}`,
      };
      await persistVideoMeta(record);
      qc.invalidateQueries({ queryKey: ["videos"] });
      toast.success("Details updated", { duration: 2000 });
    },
    [qc, savedId],
  );

  return {
    phase,
    paused,
    elapsed,
    error,
    previewUrl,
    savedId,
    savedLocalOnly,
    saveMsg,
    chosenMime,
    start,
    stop,
    pause,
    resume,
    reset,
    updateDetails,
  };
}
