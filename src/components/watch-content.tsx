import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Eye, Clock, User, CloudUpload } from "lucide-react";
import type { Comment, Reaction, Transcript } from "@/lib/types";
import {
  fetchComments,
  fetchReactions,
  fetchTranscript,
  fetchVideoMeta,
  persistComments,
  persistReactions,
  persistTranscript,
  removeRecording,
  resolveVideoUrl,
  retryUpload,
} from "@/lib/storage-client";
import { getBlob } from "@/lib/local-db";
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
  const [urlError, setUrlError] = useState<string | null>(null);

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
    setUrl(null);
    setUrlError(null);
    resolveVideoUrl(videoId)
      .then(({ primary, fallback }) => {
        if (primary) {
          setUrl(primary);
          revoke = primary;
          setFallbackUrl(fallback);
        } else if (fallback) {
          setUrl(fallback);
          setFallbackUrl(null);
        } else {
          setUrlError("No video file available for this recording.");
        }
      })
      .catch(() => setUrlError("Could not load video."));
    return () => {
      if (revoke && revoke.startsWith("blob:")) URL.revokeObjectURL(revoke);
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

  // Re-upload a local-only recording's bytes to Cloud so the shared link
  // works on other devices. Only possible on a device that still has the
  // IndexedDB blob (the original recorder). Preserves the id — no duplicate.
  const [syncing, setSyncing] = useState(false);
  const handleSyncToCloud = useCallback(async () => {
    if (!video.data) return;
    setSyncing(true);
    try {
      const blob = await getBlob(video.data.id);
      if (!blob || blob.size === 0) {
        toast.error("Local copy not found — sync is only possible on the device that recorded it.");
        return;
      }
      const res = await retryUpload(video.data, blob);
      if (res.localOnly) {
        toast.error(res.message ?? "Cloud upload failed. Try again later.");
      } else {
        toast.success("Synced to Cloud — the share link now works everywhere.");
        qc.invalidateQueries({ queryKey: ["videos"] });
        qc.invalidateQueries({ queryKey: ["video", videoId] });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
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
          {rec.localOnly ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
            >
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="flex-1">
                Local only — the cloud upload failed, so the share link won't play on other devices.
              </span>
              <button
                type="button"
                onClick={handleSyncToCloud}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {syncing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="size-3.5" />
                )}
                {syncing ? "Syncing…" : "Sync to Cloud"}
              </button>
            </div>
          ) : null}
          {urlError ? (
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                {urlError} This recording is only available locally on the device that recorded it.
              </span>
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
