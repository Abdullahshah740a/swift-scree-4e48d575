import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import { useRecordingEngine } from "@/hooks/use-recording";
import { sourceTypeLabel } from "@/lib/format";
import type { SourceType } from "@/lib/types";

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

function RecordPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const engine = useRecordingEngine(qc);
  const [source, setSource] = useState<SourceType>("screen");
  const [author, setAuthor] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");

  const { phase } = engine;

  function handleStart() {
    void engine.start({ source, author });
  }
  function handleUpdateDetails() {
    void engine.updateDetails({ title, description: desc, source, author });
  }
  function handleNewOrReset() {
    if (phase === "stopped" && engine.savedId) {
      qc.invalidateQueries({ queryKey: ["videos"] });
    }
    engine.reset();
    setTitle("");
    setDesc("");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">New recording</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Capture your screen, camera, or both. Your microphone is recorded for a voiceover. Stop
        saves automatically to the shared library.
      </p>

      {engine.error ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{engine.error}</span>
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
            onClick={handleStart}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-transform hover:scale-[1.02]"
          >
            <Circle className="size-4 fill-current" /> Start recording
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            You'll be prompted to grant screen/camera/microphone permission.
          </p>
        </div>
      ) : null}

      {phase === "recording" ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
            <span
              className={
                engine.paused
                  ? "flex size-3 rounded-full bg-warning"
                  : "flex size-3 animate-pulse rounded-full bg-destructive"
              }
            />
            <span className="font-mono text-lg font-semibold text-destructive">
              {Math.floor(engine.elapsed / 60)
                .toString()
                .padStart(2, "0")}
              :
              {Math.floor(engine.elapsed % 60)
                .toString()
                .padStart(2, "0")}
            </span>
            <span className="text-sm text-muted-foreground">
              · {engine.paused ? "paused" : `recording ${sourceTypeLabel(source)}`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={engine.paused ? engine.resume : engine.pause}
                className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
              >
                {engine.paused ? (
                  <Play className="size-4 fill-current" />
                ) : (
                  <Pause className="size-4 fill-current" />
                )}
                {engine.paused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={engine.stop}
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

      {phase === "saving" && engine.previewUrl ? (
        <div className="mt-6 flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
            <video
              src={engine.previewUrl}
              controls
              playsInline
              preload="auto"
              className="size-full max-h-[480px] w-full"
            >
              <source src={engine.previewUrl} type={engine.chosenMime} />
              Your browser does not support playing this video.
            </video>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            Saving to library…
          </div>
        </div>
      ) : null}

      {phase === "stopped" && engine.previewUrl ? (
        <div className="mt-6 flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
            <video
              src={engine.previewUrl}
              controls
              playsInline
              preload="auto"
              className="size-full max-h-[480px] w-full"
            >
              <source src={engine.previewUrl} type={engine.chosenMime} />
              Your browser does not support playing this video.
            </video>
          </div>

          {engine.saveMsg ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-foreground">
              <Check className="size-4 text-success" />
              <span>{engine.saveMsg}</span>
              {engine.savedId ? (
                <button
                  onClick={() => {
                    qc.invalidateQueries({ queryKey: ["videos"] });
                    navigate({ to: "/watch/$id", params: { id: engine.savedId! } });
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
                {sourceTypeLabel(source)} · {Math.round(engine.elapsed)}s ·{" "}
                {engine.savedLocalOnly ? "local only" : "synced"}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleUpdateDetails}
                  disabled={!engine.savedId}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Check className="size-4" /> Update details
                </button>
                <button
                  onClick={handleNewOrReset}
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
