import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize } from "lucide-react";
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
  poster?: string;
  comments?: Comment[];
  reactions?: Reaction[];
  onTimeUpdate?: (t: number) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { src, poster, comments = [], reactions = [], onTimeUpdate },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

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
    const onDur = () => setDuration(v.duration || 0);
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
  }, [onTimeUpdate]);

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const markers = [
    ...comments.map((c) => ({ time: c.time, kind: "comment" as const })),
    ...reactions.map((r) => ({ time: r.time, kind: "reaction" as const })),
  ];

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-black">
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        className="size-full w-full max-h-[70vh] bg-black"
        playsInline
        preload="auto"
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
