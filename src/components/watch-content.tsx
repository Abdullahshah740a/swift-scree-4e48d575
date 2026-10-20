import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Eye, Clock, User, RefreshCw } from "lucide-react";
import type { Comment, Reaction, Transcript } from "@/lib/types";
import {
  fetchComments,
  fetchReactions,
  fetchTranscript,
  fetchVideoMeta,
  getBlob,
  persistComments,
  persistReactions,
  persistTranscript,
  removeRecording,
  resolveVideoUrl,
  retryUpload,
} from "@/lib/storage-client";
import { transcribeVideo } from "@/lib/transcript";
import { formatDuration, formatRelativeTime, sourceTypeLabel } from "@/lib/format";
import { VideoPlayer, type VideoPlayerHandle } from "@/components/video-player";
import { ShareBar } from "@/components/share-bar";
import { CommentsPanel } from "@/components/comments-panel";
import { TranscriptPanel } from "@/components/transcript-panel";
import { ReactionBar } from "@/components/reaction-bar";
import { SourceIcon } from "@/components/source-icon";
import { toast } from "sonner";

export function WatchContent({
  videoId,
  chromeless,
  authorName = "You",
}: {
  videoId: string;
  chromeless?: boolean;
  authorName?: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [current, setCurrent] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const video = useQuery({
    queryKey: ["video", videoId],
    queryFn: () => fetchVideoMeta(videoId),
  });
  const comments = useQuery({
    queryKey: ["comments", videoId],
    queryFn: () => fetchComments(videoId),
  });
  const reactions = useQuery({
    queryKey: ["reactions", videoId],
    queryFn: () => fetchReactions(videoId),
  });
  const transcript = useQuery({
    queryKey: ["transcript", videoId],
    queryFn: () => fetchTranscript(videoId),
  });

  useEffect(() => {
    let revoke: string | null = null;
    let revokeFallback: string | null = null;
    setUrl(null);
    setUrlError(null);
    setLocalOnly(false);
    resolveVideoUrl(videoId)
      .then(({ primary, fallback, localOnly: lo }) => {
        if (primary) {
          setUrl(primary);
          if (primary.startsWith("blob:")) revoke = primary;
          setFallbackUrl(fallback ?? null);
          if (fallback && fallback.startsWith("blob:")) revokeFallback = fallback;
          setLocalOnly(Boolean(lo));
        } else if (fallback) {
          setUrl(fallback);
          if (fallback.startsWith("blob:")) revoke = fallback;
          setFallbackUrl(null);
          setLocalOnly(Boolean(lo));
        } else {
          setUrlError("No video file available for this recording.");
        }
      })
      .catch(() => setUrlError("Could not load video."));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
      if (revokeFallback) URL.revokeObjectURL(revokeFallback);
    };
  }, [videoId]);

  const addCommentMut = useMutation({
    mutationFn: async ({ text, time }: { text: string; time: number }) => {
      const next: Comment = {
        id: crypto.randomUUID(),
        videoId,
        author: authorName,
        text,
        time,
        createdAt: Date.now(),
      };
      const list = [...(comments.data ?? []), next];
      await persistComments(videoId, list);
      return next;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comments", videoId] }),
  });

  const addReactionMut = useMutation({
    mutationFn: async (emoji: string) => {
      const next: Reaction = {
        id: crypto.randomUUID(),
        videoId,
        emoji,
        author: authorName,
        time: current,
        createdAt: Date.now(),
      };
      const list = [...(reactions.data ?? []), next];
      await persistReactions(videoId, list);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reactions", videoId] }),
  });

  const [deleting, setDeleting] = useState(false);
  const handleDelete = useCallback(async () => {
    if (!video.data) return;
    const confirmed = window.confirm("Are you sure you want to delete this recording?");
    if (!confirmed) return;
    setDeleting(true);
    try {
      await removeRecording(video.data.id, video.data.ext);
      qc.invalidateQueries({ queryKey: ["videos"] });
      toast.success("Recording deleted");
      navigate({ to: "/" });
    } catch {
      toast.error("Failed to delete recording");
      setDeleting(false);
    }
  }, [navigate, qc, video.data]);

  // Retry uploading a local-only recording's bytes to Cloud. Only available
  // on the device that still has the IndexedDB blob, so the recording can
  // become shareable to other browsers/devices.
  const handleRetrySync = useCallback(async () => {
    const recMeta = video.data;
    if (!recMeta) return;
    setSyncing(true);
    try {
      const blob = await getBlob(recMeta.id);
      if (!blob || blob.size === 0) {
        toast.error("Local copy not found on this device. Open the recording on the device that made it.");
        return;
      }
      const res = await retryUpload(recMeta, blob);
      if (res.ok && !res.localOnly) {
        qc.invalidateQueries({ queryKey: ["video", videoId] });
        qc.invalidateQueries({ queryKey: ["videos"] });
        setLocalOnly(false);
        toast.success("Synced to Cloud — now shareable on other devices.");
      } else {
        toast.error(res.message ?? "Could not sync to Cloud. Try again later.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sync to Cloud.");
    } finally {
      setSyncing(false);
    }
  }, [qc, video.data, videoId]);

  const [genState, setGenState] = useState<{
    generating: boolean;
    progress: { pct: number; msg: string } | null;
  }>({ generating: false, progress: null });

  const generateTranscript = useCallback(async () => {
    if (!url) return;
    setGenState({ generating: true, progress: { pct: 0, msg: "Loading…" } });
    try {
      const segments = await transcribeVideo(url, (pct, msg) =>
        setGenState({ generating: true, progress: { pct, msg } }),
      );
      const next: Transcript = {
        videoId,
        segments,
        generatedAt: Date.now(),
      };
      await persistTranscript(next);
      qc.invalidateQueries({ queryKey: ["transcript", videoId] });
      toast.success("Transcript generated");
    } catch (e) {
      toast.error(
        e instanceof Error ? `Transcription failed: ${e.message}` : "Transcription failed",
      );
    } finally {
      setGenState({ generating: false, progress: null });
    }
  }, [qc, url, videoId]);

  const seek = useCallback((t: number) => {
    playerRef.current?.seek(t);
  }, []);

  const rec = video.data;
  const showTabs = !chromeless;

  const meta = useMemo(() => {
    if (!rec) return null;
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <SourceIcon type={rec.sourceType} className="size-3.5" />
          {sourceTypeLabel(rec.sourceType)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Eye className="size-3.5" /> {rec.views} views
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3.5" /> {formatDuration(rec.duration)}
        </span>
        <span className="inline-flex items-center gap-1">
          <User className="size-3.5" /> {rec.author}
        </span>
        <span>{formatRelativeTime(rec.createdAt)}</span>
      </div>
    );
  }, [rec]);

  if (video.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  if (!rec) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <AlertTriangle className="mx-auto size-10 text-warning" />
        <h1 className="mt-4 text-xl font-semibold text-foreground">Recording not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This recording may have been deleted, or Cloud storage isn't configured so it only exists
          on the device that recorded it.
        </p>
      </div>
    );
  }

  return (
    <div className={chromeless ? "" : "mx-auto max-w-6xl px-4 py-6"}>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-3">
          {urlError ? (
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                {urlError} This recording is only available locally on the device that recorded it.
              </span>
            </div>
          ) : null}
          {localOnly && !urlError ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="flex-1">
                Local only — not synced to Cloud. Other devices can't open this recording yet.
              </span>
              <button
                type="button"
                onClick={handleRetrySync}
                disabled={syncing}
                className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-60"
              >
                {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {syncing ? "Syncing…" : "Retry sync to Cloud"}
              </button>
            </div>
          ) : null}
          <VideoPlayer
            ref={playerRef}
            src={url ?? ""}
            fallbackSrc={fallbackUrl ?? undefined}
            poster={rec.thumbnail}
            comments={comments.data ?? []}
            reactions={reactions.data ?? []}
            onTimeUpdate={setCurrent}
            localOnly={localOnly}
          />
          <ReactionBar
            reactions={reactions.data ?? []}
            current={current}
            onAdd={(emoji) => addReactionMut.mutate(emoji)}
            onSeek={seek}
          />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">{rec.title}</h1>
            {meta}
            {rec.description ? (
              <p className="mt-3 text-sm text-muted-foreground">{rec.description}</p>
            ) : null}
          </div>
          <ShareBar video={rec} onDelete={chromeless ? undefined : handleDelete} />

          {showTabs ? (
            <div className="mt-2 grid gap-4 lg:grid-cols-2">
              <CommentsPanel
                comments={comments.data ?? []}
                current={current}
                onAdd={(text, time) => addCommentMut.mutate({ text, time })}
                onSeek={seek}
              />
              <TranscriptPanel
                transcript={transcript.data ?? null}
                generating={genState.generating}
                progress={genState.progress}
                onGenerate={generateTranscript}
                onSeek={seek}
              />
            </div>
          ) : (
            <div className="mt-2 grid gap-4 lg:grid-cols-2">
              <CommentsPanel
                comments={comments.data ?? []}
                current={current}
                onAdd={(text, time) => addCommentMut.mutate({ text, time })}
                onSeek={seek}
              />
              <TranscriptPanel
                transcript={transcript.data ?? null}
                generating={genState.generating}
                progress={genState.progress}
                onGenerate={generateTranscript}
                onSeek={seek}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
