import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Circle,
  Square,
  Pause,
  Play,
  Monitor,
  Camera,
  MonitorSpeaker,
  Check,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import {
  captureThumb,
  createRecorder,
  getCameraStream,
  getScreenStream,
  validateRecordingBlob,
  type RecordingStreams,
} from "@/lib/media";
import { extFromMime, sourceTypeLabel } from "@/lib/format";
import { persistVideoMeta } from "@/lib/storage-client";
import { finalizeAndSaveRecording } from "@/lib/recording-save";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SourceType, VideoRecord } from "@/lib/types";

export const Route = createFileRoute("/record")({
  head: () => ({
    meta: [
      { title: "Swift Screen — Record" },
      {
        name: "description",
        content: "Record your screen and camera with Swift Screen.",
      },
      { property: "og:title", content: "Swift Screen — Record" },
      {
        property: "og:description",
        content: "Record your screen and camera with Swift Screen.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RecordPage,
});

type Phase = "idle" | "recording" | "finalizing" | "saving" | "stopped";

function RecordPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [source, setSource] = useState<SourceType>("screen");
  const [phase, setPhase] = useState<Phase>("idle");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string>("");
  const [duration, setDuration] = useState(0);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [desc, setDesc] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedLocalOnly, setSavedLocalOnly] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamsRef = useRef<RecordingStreams>({ screen: null, camera: null });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const chosenMimeRef = useRef<string>("video/webm");
  // The blob built in onstop, kept in a ref so the async save reads the
  // finalized value without depending on state that hasn't committed yet.
  const blobRef = useRef<Blob | null>(null);
  // Elapsed-time bookkeeping that survives pause/resume.
  const startedAtRef = useRef<number>(0);
  const baseElapsedRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);
  // Guards the stop/finalize flow so onstop + safety net can never double-fire,
  // and the UI can never hang on "Finalizing…". This is the SINGLE point that
  // builds and saves the final blob — onstop is authoritative.
  const finalizeStartedRef = useRef<boolean>(false);
  const stopRequestedRef = useRef<boolean>(false);
  const safetyTimerRef = useRef<number | null>(null);
  // Records a MediaRecorder error so onstop can decide whether the captured
  // data is salvageable. onerror itself never finalizes — that was the bug
  // that saved incomplete recordings as valid.
  const recorderErrorRef = useRef<string | null>(null);

  // Hidden <video> elements MUST be in the DOM or browsers won't decode and
  // the composite "both" recording is a static frame. They're also used to
  // capture thumbnails in every mode, so they must receive the stream in all
  // modes — otherwise drawImage throws InvalidStateError and breaks onstop.
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

  // Elapsed timer. Freezes while paused so the clock reflects real recorded
  // time, not wall-clock time.
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

  function stopAllStreams() {
    streamsRef.current.screen?.getTracks().forEach((t) => t.stop());
    streamsRef.current.camera?.getTracks().forEach((t) => t.stop());
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamsRef.current = { screen: null, camera: null };
    streamRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }

  // SINGLE authoritative finalize path, called only from onstop. The safety
  // net never builds a blob — it only calls rec.stop() so onstop fires. onerror
  // never finalizes — it records the error and lets onstop complete. Idempotent.
  function finalizeFromChunks(_reason: "onstop") {
    if (finalizeStartedRef.current) return;
    finalizeStartedRef.current = true;
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }

    const total = pausedRef.current
      ? baseElapsedRef.current
      : baseElapsedRef.current + (Date.now() - startedAtRef.current) / 1000;
    setDuration(total);

    // MediaRecorder.mimeType on the instance gives the exact actual recording format
    const actualMime = recorderRef.current?.mimeType || chosenMimeRef.current || "video/webm";
    chosenMimeRef.current = actualMime;
    const chunkCount = chunksRef.current.length;
    const finalBlob = new Blob(chunksRef.current, { type: actualMime });
    console.info("[record] finalize", {
      mime: actualMime,
      chunkCount,
      blobSize: finalBlob.size,
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
      const thumbEl = source === "camera" ? camVideoRef.current : screenVideoRef.current;
      if (thumbEl) {
        thumbData = captureThumb(thumbEl);
        setThumb(thumbData);
      }
    } catch {
      /* thumbnail optional */
    }
    stopAllStreams();
    void finalizeAndSave(finalBlob, total, thumbData);
  }

  // Called directly from onstop — this is what makes Stop actually persist
  // the recording. The old flow left it on a "Save to library" button.
  async function finalizeAndSave(finalBlob: Blob, totalSeconds: number, thumbData: string) {
    setPhase("saving");
    const mimeType = chosenMimeRef.current;
    const result = await finalizeAndSaveRecording(
      finalBlob,
      mimeType,
      chunksRef.current.length,
      totalSeconds,
      { source, author, thumbData },
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

  async function startRecording() {
    setError(null);
    chunksRef.current = [];
    blobRef.current = null;
    stopRequestedRef.current = false;
    finalizeStartedRef.current = false;
    recorderErrorRef.current = null;
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    setThumb("");
    setDuration(0);
    setElapsed(0);
    setPaused(false);
    setSavedId(null);
    setSaveMsg(null);
    pausedRef.current = false;
    baseElapsedRef.current = 0;

    try {
      let combined: MediaStream;
      if (source === "screen") {
        const s = await getScreenStream();
        streamsRef.current.screen = s;
        combined = s;
        const sv = screenVideoRef.current!;
        sv.srcObject = s;
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
        let cam: MediaStream | null = null;
        try {
          cam = await getCameraStream();
          streamsRef.current.camera = cam;
        } catch {
          // camera optional in "both"; fall back to screen only
        }

        const screenV = screenVideoRef.current!;
        const camV = camVideoRef.current!;
        screenV.srcObject = s;
        await screenV.play().catch(() => {});
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
          ctx.drawImage(screenV, 0, 0, canvas.width, canvas.height);
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
        if (s.getAudioTracks().length) {
          s.getAudioTracks().forEach((t) => combined.addTrack(t));
        }
      }

      streamRef.current = combined;
      // createRecorder matches the codec string to the stream's actual tracks
      // (video-only codec when there's no audio) so a silent screen capture
      // never produces 0 chunks. It returns the recorder's real mimeType.
      const { recorder: rec, mimeType } = createRecorder(combined);
      chosenMimeRef.current = mimeType;
      recorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onerror = (e) => {
        // Record the error but do NOT finalize here. onerror can fire before
        // the recorder has flushed its final dataavailable chunk, so building
        // the blob now would save an incomplete recording. We let onstop
        // (which always fires after the final flush) be authoritative, and
        // the validation there decides whether the captured data is usable.
        const err = (e as unknown as { error?: Error }).error;
        recorderErrorRef.current = err?.message ?? "Recorder error";
        console.warn("[record] MediaRecorder error", recorderErrorRef.current);
        // If the recorder is still active, stop it so onstop can finalize.
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            /* already stopping */
          }
        }
      };
      rec.onstop = () => {
        // Canonical finalize path. stop() always fires this AFTER the final
        // dataavailable chunk; the safety net only calls stop() as a fallback.
        finalizeFromChunks("onstop");
      };
      // When the user clicks the browser's native "Stop sharing" bar, the
      // screen track ends. Treat that as a graceful stop, not an error.
      combined.getTracks().forEach((t) => {
        t.addEventListener("ended", () => {
          console.info("[record] track ended, stopping gracefully");
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
  }

  function pauseRecording() {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    baseElapsedRef.current += (Date.now() - startedAtRef.current) / 1000;
    rec.pause();
    pausedRef.current = true;
    setPaused(true);
  }

  function resumeRecording() {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    startedAtRef.current = Date.now();
    rec.resume();
    pausedRef.current = false;
    setPaused(false);
  }

  // stop() fires onstop (which finalizes). We do NOT call requestData()
  // first: stop() already flushes a final dataavailable chunk, and calling
  // requestData() immediately before stop() races in Chrome and can suppress
  // the stop event — that was the bug where the UI hung on "Finalizing…".
  // The safety net only re-calls stop() (never builds a blob) if onstop
  // hasn't fired in 5s, so a stalled transport can't hang the UI.
  function stopRecording() {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setPhase("finalizing");
    safetyTimerRef.current = window.setTimeout(() => {
      // onstop didn't fire in time — nudge stop() again; onstop is still the
      // only path that builds the blob. If the recorder is already inactive,
      // call finalize directly as a last resort.
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
  }

  async function updateDetails() {
    if (!savedId) return;
    const mimeType = chosenMimeRef.current;
    const ext = extFromMime(mimeType);
    const record: VideoRecord = {
      id: savedId,
      title: title.trim() || `Recording ${new Date().toLocaleString()}`,
      description: desc.trim(),
      author: author.trim() || "You",
      mimeType,
      ext,
      duration: Math.round(duration),
      size: blobRef.current?.size ?? 0,
      sourceType: source,
      thumbnail: thumb,
      folderId: null,
      views: 0,
      createdAt: Date.now(),
      storagePath: `videos/${savedId}.${ext}`,
    };
    await persistVideoMeta(record);
    qc.invalidateQueries({ queryKey: ["videos"] });
    toast.success("Details updated");
  }

  function resetToIdle() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPhase("idle");
    setPreviewUrl(null);
    blobRef.current = null;
    finalizeStartedRef.current = false;
    stopRequestedRef.current = false;
    recorderErrorRef.current = null;
    setSavedId(null);
    setSaveMsg(null);
    setTitle("");
    setDesc("");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">New recording</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Capture your screen, camera, or both. Stop saves automatically to the shared library.
      </p>

      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {phase === "idle" ? (
        <div className="mt-6">
          <p className="text-sm font-medium text-foreground">Capture source</p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SourceOption
              active={source === "screen"}
              onClick={() => setSource("screen")}
              icon={<Monitor className="size-5" />}
              label="Screen only"
              desc="Capture any window or display"
            />
            <SourceOption
              active={source === "camera"}
              onClick={() => setSource("camera")}
              icon={<Camera className="size-5" />}
              label="Camera only"
              desc="Record from your webcam"
            />
            <SourceOption
              active={source === "both"}
              onClick={() => setSource("both")}
              icon={<MonitorSpeaker className="size-5" />}
              label="Screen + Cam"
              desc="Composite webcam over screen"
            />
          </div>

          <div className="mt-5 max-w-xs">
            <label className="text-sm font-medium text-foreground">Your name</label>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Optional — shows on share pages"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <button
            onClick={startRecording}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-transform hover:scale-[1.02]"
          >
            <Circle className="size-4 fill-current" /> Start recording
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            You'll be prompted to grant screen/camera permission.
          </p>
        </div>
      ) : null}

      {phase === "recording" ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
            <span
              className={
                paused
                  ? "flex size-3 rounded-full bg-warning"
                  : "flex size-3 animate-pulse rounded-full bg-destructive"
              }
            />
            <span className="font-mono text-lg font-semibold text-destructive">
              {Math.floor(elapsed / 60)
                .toString()
                .padStart(2, "0")}
              :
              {Math.floor(elapsed % 60)
                .toString()
                .padStart(2, "0")}
            </span>
            <span className="text-sm text-muted-foreground">
              · {paused ? "paused" : `recording ${sourceTypeLabel(source)}`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={paused ? resumeRecording : pauseRecording}
                className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
              >
                {paused ? (
                  <Play className="size-4 fill-current" />
                ) : (
                  <Pause className="size-4 fill-current" />
                )}
                {paused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={stopRecording}
                className="inline-flex items-center gap-2 rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90"
              >
                <Square className="size-4 fill-current" /> Stop
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "finalizing" ? (
        <div className="mt-6 flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" />
          Finalizing your recording…
        </div>
      ) : null}

      {phase === "saving" && previewUrl ? (
        <div className="mt-6 flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
            <video
              src={previewUrl}
              controls
              playsInline
              preload="auto"
              className="size-full max-h-[480px] w-full"
            >
              <source src={previewUrl} type={chosenMimeRef.current} />
              Your browser does not support playing this video.
            </video>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            Saving to library…
          </div>
        </div>
      ) : null}

      {phase === "stopped" && previewUrl ? (
        <div className="mt-6 flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
            <video
              src={previewUrl}
              controls
              playsInline
              preload="auto"
              className="size-full max-h-[480px] w-full"
            >
              <source src={previewUrl} type={chosenMimeRef.current} />
              Your browser does not support playing this video.
            </video>
          </div>

          {saveMsg ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-foreground">
              <Check className="size-4 text-success" />
              {saveMsg}
              {savedId ? (
                <button
                  onClick={() => {
                    qc.invalidateQueries({ queryKey: ["videos"] });
                    navigate({ to: "/watch/$id", params: { id: savedId } });
                  }}
                  className="ml-auto text-primary hover:underline"
                >
                  Watch →
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`Recording ${new Date().toLocaleString()}`}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <label className="mt-1 text-sm font-medium text-foreground">Description</label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="What's this about?"
                rows={3}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-col justify-end gap-3">
              <p className="text-xs text-muted-foreground">
                {sourceTypeLabel(source)} · {Math.round(duration)}s ·{" "}
                {savedLocalOnly ? "local only" : "synced"}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={updateDetails}
                  disabled={!savedId}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Check className="size-4" /> Update details
                </button>
                <button
                  onClick={resetToIdle}
                  className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RefreshCw className="size-4" /> New recording
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SourceOption({
  active,
  onClick,
  icon,
  label,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors"
      style={{
        borderColor: active ? "var(--primary)" : "var(--border)",
        background: active ? "color-mix(in oklab, var(--primary) 10%, transparent)" : "transparent",
      }}
    >
      <span
        className="text-primary"
        style={{ color: active ? "var(--primary)" : "var(--muted-foreground)" }}
      >
        {icon}
      </span>
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">{desc}</span>
    </button>
  );
}
