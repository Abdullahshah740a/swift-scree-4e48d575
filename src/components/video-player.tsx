import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, RotateCw } from "lucide-react";
import { formatDuration } from "@/lib/format";
import type { Comment, Reaction } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface VideoPlayerHandle {
  getCurrentTime: () => number;
  seek: (t: number) => void;
  getVideo: () => HTMLVideoElement | null;
}

interface Props {
  src: string;
  fallbackSrc?: string | undefined;
  poster?: string;
  comments?: Comment[];
  reactions?: Reaction[];
  onTimeUpdate?: (t: number) => void;
  localOnly?: boolean;
}

/**
 * Map a HTMLMediaElement error code to a human-friendly, actionable reason.
 * The old handler lumped network, unsupported-source, and decoding failures
 * under one generic "could not be decoded" message — which hid the real
 * cross-browser cause (a missing/empty Cloud object reported by the network
 * layer as code 4, or a genuine decode corruption as code 3).
 */
function describeError(
  code: number | undefined,
  message: string | undefined,
  localOnly: boolean,
): string {
  if (code === 1) return "Loading was interrupted. Retrying…";
  if (code === 2) return "Network error while loading the video. Check your connection and retry.";
  if (code === 3) {
    return localOnly
      ? "This recording couldn't be decoded on this device. It is stored locally on the device that recorded it — try opening it there, or retry syncing to Cloud."
      : "The video file appears to be corrupted or incomplete. Try re-syncing this recording to Cloud.";
  }
  if (code === 4) {
    return localOnly
      ? "This recording is only available locally on the device that recorded it. Open it there, or retry syncing to Cloud."
      : "This video format isn't supported by this browser, or the file is missing from Cloud storage.";
  }
  return message || "The video file could not be played by the browser media engine.";
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { src, fallbackSrc, poster, comments = [], reactions = [], onTimeUpdate, localOnly = false },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<
    { code: number | undefined; message: string | undefined } | null
  >(null);
  // Try sources in order: primary first, then the fallback once. The fallback
  // is re-primed whenever the primary src changes (e.g. retry).
  const [activeSrc, setActiveSrc] = useState(src);
  const triedFallback = useRef(false);
  const [retried, setRetried] = useState(0);

  useEffect(() => {
    setActiveSrc(src);
    triedFallback.current = false;
    setVideoError(null);
    setErrorState(null);
  }, [src]);

  // Force a reload of the video element when the user hits "Retry playback".
  const retryPlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setVideoError(null);
    setErrorState(null);
    setRetried((n) => n + 1);
  }, []);

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
    seek: (t: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = t;
        setCurrent(t);
      }
    },
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
    const onDur = () => setDuration(Number.isFinite(v.duration) ? v.duration || 0 : 0);
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
  }, [onTimeUpdate, retried]);

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const markers = [
    ...comments.map((c) => ({ time: c.time, kind: "comment" as const })),
    ...reactions.map((r) => ({ time: r.time, kind: "reaction" as const })),
  ];

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-black">
      {videoError ? (
        <div
          className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
          role="alert"
          aria-live="assertive"
        >
          <p className="text-sm font-medium text-foreground">Playback issue</p>
          <p className="max-w-md text-xs text-muted-foreground">{videoError}</p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={retryPlayback}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <RotateCw className="size-3.5" /> Retry playback
            </button>
            {fallbackSrc && fallbackSrc !== activeSrc ? (
              <button
                type="button"
                onClick={() => {
                  setVideoError(null);
                  setErrorState(null);
                  triedFallback.current = true;
                  setActiveSrc(fallbackSrc);
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
              >
                Try alternate source
              </button>
            ) : null}
          </div>
          {errorState ? (
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              Media error {errorState.code ? `#${errorState.code}` : ""}:{" "}
              {errorState.message || "no message"}
            </p>
          ) : null}
        </div>
      ) : null}
      <video
        key={`${activeSrc}-${retried}`}
        ref={videoRef}
        src={videoError ? undefined : activeSrc}
        poster={poster}
        className={cn("size-full w-full max-h-[70vh] bg-black", videoError && "hidden")}
        playsInline
        preload="auto"
        controls={false}
        onError={(e) => {
          const err = e.currentTarget.error;
          const code = err?.code;
          const message = err?.message;
          console.warn("Video playback error:", { code, message, activeSrc, localOnly });
          // Ignore aborted loads (code 1) from src swaps/retries.
          if (code === 1) return;
          // If there's still a fallback we haven't tried, try it before giving up.
          if (
            !triedFallback.current &&
            fallbackSrc &&
            fallbackSrc !== activeSrc &&
            code !== undefined
          ) {
            triedFallback.current = true;
            setVideoError(null);
            setErrorState(null);
            setActiveSrc(fallbackSrc);
            return;
          }
          setErrorState({ code, message });
          setVideoError(describeError(code, message, localOnly));
        }}
        onClick={togglePlay}
      />
      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent p-3 opacity-100 transition-opacity">
        <div
          className="relative mb-2 h-2 cursor-pointer rounded-full bg-white/20"
          onClick={(e) => {
            const v = videoRef.current;
            if (!v || !duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const t = ((e.clientX - rect.left) / rect.width) * duration;
            v.currentTime = t;
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
              style={{ left: `${duration ? (m.time / duration) * 100 : 0}%` }}
            />
          ))}
        </div>
        <div className="flex items-center gap-3 text-white">
          <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <span className="font-mono text-xs tabular-nums">
            {formatDuration(current)} / {formatDuration(duration)}
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
