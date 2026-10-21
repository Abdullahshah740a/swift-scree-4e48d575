import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize } from "lucide-react";
import { formatDuration } from "@/lib/format";
import type { Comment, Reaction } from "@/lib/types";
import { cn } from "@/lib/utils";
import { finiteDuration, seekTarget } from "@/lib/playback-time";
import { makeSeekableWebm } from "@/lib/seekable-webm";

export interface VideoPlayerHandle {
  getCurrentTime: () => number;
  seek: (t: number) => void;
  getVideo: () => HTMLVideoElement | null;
}

interface Props {
  src: string;
  fallbackSrc?: string | undefined;
  repairSrc?: string;
  mimeType?: string;
  durationHint?: number;
  poster?: string;
  comments?: Comment[];
  reactions?: Reaction[];
  onTimeUpdate?: (t: number) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  {
    src,
    fallbackSrc,
    repairSrc,
    mimeType,
    durationHint,
    poster,
    comments = [],
    reactions = [],
    onTimeUpdate,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [videoError, setVideoError] = useState<string | null>(null);
  // When the primary src fails to decode (e.g. a stale IndexedDB blob), swap
  // to the remote streaming URL once, then surface a real error if that also
  // fails.
  const [activeSrc, setActiveSrc] = useState(src);
  const triedFallback = useRef(false);
  const [repairFor, setRepairFor] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairWarning, setRepairWarning] = useState<string | null>(null);
  const restorePlayback = useRef<{ time: number; playing: boolean } | null>(null);

  useEffect(() => {
    setActiveSrc(src);
    triedFallback.current = false;
    setVideoError(null);
    setCurrent(0);
    setDuration(0);
    setPlaying(false);
    setRepairFor(null);
    setRepairing(false);
    setRepairWarning(null);
    restorePlayback.current = null;
  }, [src]);

  // Old Firefox/MediaRecorder files have Duration=0 and no usable seek index.
  // Rebuild a browser-local copy; the original cloud object stays recoverable.
  useEffect(() => {
    if (!src || repairFor !== src) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Video repair timed out", "TimeoutError")),
      120000,
    );
    let active = true;
    let objectUrl: string | null = null;
    setRepairing(true);
    void (async () => {
      try {
        // Use the same-origin attachment stream for remote files, avoiding
        // cross-origin redirects/CORS during the repair download.
        const response = await fetch(src.startsWith("blob:") ? src : (repairSrc ?? src), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Video download failed (${response.status}).`);
        const original = await response.blob();
        const blob = new Blob([original], { type: mimeType || original.type });
        const repaired = await makeSeekableWebm(blob, controller.signal);
        controller.signal.throwIfAborted();
        const video = videoRef.current;
        restorePlayback.current = {
          time: video?.currentTime ?? 0,
          playing: !!video && !video.paused,
        };
        objectUrl = URL.createObjectURL(repaired);
        setVideoError(null);
        setActiveSrc(objectUrl);
      } catch (error) {
        if (!active) {
          // Unmount/source changes must not update a different recording.
          return;
        }
        console.warn("[player] WebM repair failed", error);
        setRepairWarning("Could not prepare seeking. Reload the recording to try again.");
      } finally {
        clearTimeout(timer);
        if (active) setRepairing(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, repairFor, repairSrc, mimeType]);

  const displayDuration = finiteDuration(duration) || finiteDuration(durationHint);
  const seek = useCallback(
    (time: number) => {
      const video = videoRef.current;
      const target = seekTarget(time, displayDuration);
      if (!video || target === null || video.readyState < 1) return;
      try {
        video.currentTime = target;
        setCurrent(target);
      } catch (error) {
        console.warn("[player] seek unavailable", error);
      }
    },
    [displayDuration],
  );

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
    seek,
    getVideo: () => videoRef.current,
  }));

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onDur = () => {
      const actual = finiteDuration(v.duration);
      setDuration(actual);
      if (actual && !v.error) setVideoError(null);
      if (v.readyState >= 1 && !actual && mimeType?.toLowerCase().includes("webm")) {
        setRepairFor(src);
      }
      if (actual && restorePlayback.current) {
        const restore = restorePlayback.current;
        restorePlayback.current = null;
        // A fresh source already starts at zero. Forcing an early seek to zero
        // during loadedmetadata can fail before the demuxer has buffered frames.
        if (restore.time > 0) v.currentTime = seekTarget(restore.time, actual) ?? 0;
        if (restore.playing) void v.play().catch(() => {});
      }
    };
    const onTime = () => {
      setCurrent(v.currentTime);
      onTimeUpdate?.(v.currentTime);
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("loadedmetadata", onDur);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("loadedmetadata", onDur);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [onTimeUpdate, mimeType, src]);

  const pct = displayDuration > 0 ? Math.min(100, (current / displayDuration) * 100) : 0;
  const markers = [
    ...comments.map((c) => ({ time: c.time, kind: "comment" as const })),
    ...reactions.map((r) => ({ time: r.time, kind: "reaction" as const })),
  ];

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-black">
      {repairing || repairWarning ? (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-x-0 top-0 z-10 bg-black/75 px-3 py-2 text-xs text-white"
        >
          {repairing ? "Preparing video seeking…" : repairWarning}
        </div>
      ) : null}
      {videoError ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center p-6 text-center text-muted-foreground">
          <p className="text-sm font-medium text-foreground">Playback issue</p>
          <p className="mt-1 text-xs text-muted-foreground">{videoError}</p>
          <a
            href={activeSrc}
            download
            className="mt-3 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent"
          >
            Download video directly
          </a>
        </div>
      ) : null}
      <video
        ref={videoRef}
        src={activeSrc}
        poster={poster}
        className={cn("size-full w-full max-h-[70vh] bg-black", videoError && "hidden")}
        playsInline
        preload="auto"
        controls={false}
        onError={async (e) => {
          const failedVideo = e.currentTarget;
          const err = failedVideo.error;
          if (!err) return;
          const failedSource = failedVideo.currentSrc;
          const isCurrentFailure = () =>
            videoRef.current === failedVideo &&
            failedVideo.currentSrc === failedSource &&
            failedVideo.error !== null;
          console.warn("Video playback error code:", err.code, err.message, "src:", activeSrc);
          // Ignore aborted loads (code 1) from src swaps.
          if (!activeSrc || err.code === 1) return;
          if (repairing) return;

          // Probe the source to distinguish "file missing / unreachable" from
          // a decode/format problem. A 410 from the playback route means the
          // cloud object is gone (a pre-localOnly recording whose upload timed
          // out but whose metadata was saved). A 404/5xx is a
          // network/storage failure. We do NOT assume a specific cause from
          // MediaError.code alone — code 4 ("source not supported") can mean a
          // missing/truncated object, an unsupported container, or an
          // unsupported codec depending on the browser and the actual bytes
          // received. The probe tells us which; the message stays neutral
          // until the cause is established.
          const codeNames: Record<number, string> = {
            1: "aborted",
            2: "network error",
            3: "decode error",
            4: "source not supported",
          };
          let missing = false;
          try {
            const probe = await fetch(activeSrc, { method: "GET" });
            if (!isCurrentFailure()) {
              void probe.body?.cancel();
              return;
            }
            if (probe.status === 410) {
              const body = await probe.json().catch(() => ({}));
              if (!isCurrentFailure()) return;
              missing = true;
              setVideoError(
                body.message ??
                  "The video file is missing from cloud storage. This recording may only exist on the device that recorded it.",
              );
              return;
            }
            if (probe.status === 404 || probe.status >= 500) {
              setVideoError(
                "The video could not be reached (server error). Try again in a moment.",
              );
              return;
            }
          } catch {
            /* fall through to fallback handling */
          }

          // A probe for the old URL may finish after WebM repair/source swap.
          if (!isCurrentFailure()) return;

          // Try the remote streaming URL once before giving up.
          if (!triedFallback.current && fallbackSrc && fallbackSrc !== activeSrc) {
            triedFallback.current = true;
            setVideoError(null);
            setActiveSrc(fallbackSrc);
            return;
          }
          if (missing) return;
          // Neutral message: we have not established whether this is a missing
          // object, a truncated file, or a codec the browser can't decode.
          // Avoid claiming a specific format incompatibility without evidence.
          setVideoError(
            `Playback failed (${codeNames[err.code] ?? "error"}). The recording may be incomplete, missing from storage, or in a format this browser can’t decode.`,
          );
        }}
        onClick={togglePlay}
      />
      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent p-3 opacity-100 transition-opacity">
        <div
          className="relative mb-2 h-2 cursor-pointer rounded-full bg-white/20"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width <= 0) return;
            seek(((e.clientX - rect.left) / rect.width) * displayDuration);
          }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${pct}%` }}
          />
          {markers.map((m, i) => (
            <span
              key={i}
              title={`${m.kind} @ ${formatDuration(m.time)}`}
              className={cn(
                "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                m.kind === "comment" ? "bg-accent" : "bg-primary",
              )}
              style={{ left: `${displayDuration ? (m.time / displayDuration) * 100 : 0}%` }}
            />
          ))}
        </div>
        <div className="flex items-center gap-3 text-white">
          <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <span className="font-mono text-xs tabular-nums">
            {formatDuration(current)} / {formatDuration(displayDuration)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                v.muted = !v.muted;
                setMuted(v.muted);
              }}
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const val = Number(e.target.value);
                setVolume(val);
                if (videoRef.current) {
                  videoRef.current.volume = val;
                  videoRef.current.muted = val === 0;
                  setMuted(val === 0);
                }
              }}
              className="hidden w-20 accent-primary sm:block"
              aria-label="Volume"
            />
            <button onClick={() => videoRef.current?.requestFullscreen()} aria-label="Fullscreen">
              <Maximize className="size-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
