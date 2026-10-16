import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Eye, Clock, User } from "lucide-react";
import type { Comment, Reaction, Transcript } from "@/lib/types";
import {
  fetchComments,
  fetchReactions,
  fetchTranscript,
  fetchVideoMeta,
  persistComments,
  persistReactions,
  persistTranscript,
  resolveVideoUrl,
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
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [current, setCurrent] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
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
      .then((u) => {
        if (u) {
          setUrl(u);
          revoke = u;
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
          <VideoPlayer
            ref={playerRef}
            src={url ?? ""}
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
          <ShareBar videoId={rec.id} title={rec.title} mimeType={rec.mimeType} ext={rec.ext} />

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
