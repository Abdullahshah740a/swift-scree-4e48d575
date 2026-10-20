import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Eye, Clock, User, CloudUpload, Copy } from "lucide-react";
import type { Comment, Reaction, SyncDiagnostics, Transcript } from "@/lib/types";
import {
  fetchComments,
  fetchReactions,
  fetchTranscript,
  fetchVideoMeta,
  fetchVideoObjectStatus,
  persistComments,
  persistReactions,
  persistTranscript,
  removeRecording,
  resolveVideoUrl,
  retryUpload,
} from "@/lib/storage-client";
import { getBlob } from "@/lib/local-db";
import { transcribeVideo } from "@/lib/transcript";
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  sourceTypeLabel,
  diagnosticsToText,
} from "@/lib/format";
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

  // Detect a missing cloud binary for recordings made before the localOnly
  // flag existed: they have cloud metadata but no cloud video object (the old
  // base64-over-RPC upload timed out, meta was saved anyway). Only check when
  // the record is NOT already flagged localOnly (those already show the sync
  // banner) and we have the ext to build the object path.
  const objectStatus = useQuery({
    queryKey: ["video-object", videoId],
    queryFn: () => fetchVideoObjectStatus(videoId, video.data?.ext ?? "webm"),
    enabled: !!video.data && !video.data.localOnly,
  });

  // Whether a local IndexedDB blob exists for this recording — recovery is
  // only possible on the device that recorded it. Checked once the missing
  // cloud binary is detected.
  const [hasLocalBlob, setHasLocalBlob] = useState<boolean | null>(null);
  useEffect(() => {
    if (!video.data) return;
    // Only probe local IndexedDB when recovery is plausible: the record is
    // flagged localOnly (upload never confirmed) OR the cloud binary is
    // confirmed missing (404). An "unknown" verification status does NOT mean
    // missing, so we don't offer recovery for it — the file may still exist.
    if (video.data.localOnly) {
      getBlob(video.data.id)
        .then((b) => setHasLocalBlob(!!b && b.size > 0))
        .catch(() => setHasLocalBlob(false));
      return;
    }
    if (objectStatus.data?.status === "missing") {
      getBlob(video.data.id)
        .then((b) => setHasLocalBlob(!!b && b.size > 0))
        .catch(() => setHasLocalBlob(false));
    }
  }, [video.data, objectStatus.data]);

  const cloudBinaryMissing =
    !!video.data && !video.data.localOnly && objectStatus.data?.status === "missing";
  const cloudBinaryUnverified =
    !!video.data && !video.data.localOnly && objectStatus.data?.status === "unknown";

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
  const [syncDiag, setSyncDiag] = useState<SyncDiagnostics | null>(null);
  const handleSyncToCloud = useCallback(async () => {
    if (!video.data) return;
    setSyncing(true);
    setSyncDiag(null);
    // Capture a diagnostic for EVERY failure path — including an unexpected
    // throw from retryUpload (AbortError/network). Without this, the catch
    // block below would only show a toast and the diagnostic block (with the
    // real cause of the ~120s wait) would be lost — which is exactly what
    // made the button "just revert to Sync to Cloud" with no details.
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const recId = video.data.id;
    let blobSize = 0;
    let mime = video.data.mimeType;
    let ext = video.data.ext;
    try {
      const blob = await getBlob(video.data.id);
      if (!blob || blob.size === 0) {
        const diag: SyncDiagnostics = {
          recordingId: recId,
          stage: "local-cache",
          failed: true,
          blobSize: 0,
          blobSizeMb: "0 B",
          mimeType: mime,
          ext,
          elapsedMs: Date.now() - startedAtMs,
          startedAt,
          httpStatus: null,
          errorKind: "local-cache-missing",
          errorMessage:
            "Local copy not found — sync is only possible on the device that recorded it.",
          rawName: "LocalCache",
        };
        setSyncDiag(diag);
        toast.error(diag.errorMessage ?? "Local copy not found.");
        return;
      }
      blobSize = blob.size;
      const res = await retryUpload(video.data, blob);
      if (res.localOnly) {
        toast.error(res.message ?? "Cloud upload failed. Try again later.");
        if (res.diag) setSyncDiag(res.diag);
        else
          setSyncDiag({
            recordingId: recId,
            stage: "upload-proxy",
            failed: true,
            blobSize,
            blobSizeMb: formatBytes(blobSize),
            mimeType: mime,
            ext,
            elapsedMs: Date.now() - startedAtMs,
            startedAt,
            httpStatus: null,
            errorKind: "unknown",
            errorMessage: res.message ?? "Cloud upload failed.",
            rawName: "RetryUpload",
          });
      } else {
        toast.success("Synced to Cloud — the share link now works everywhere.");
        qc.invalidateQueries({ queryKey: ["videos"] });
        qc.invalidateQueries({ queryKey: ["video", videoId] });
        qc.invalidateQueries({ queryKey: ["video-object", videoId] });
        setSyncDiag(null);
      }
    } catch (e) {
      // Unexpected throw (e.g. the 120s AbortError fired by the client
      // timeout). Preserve the sanitized diagnostic so the user can SEE why
      // it waited two minutes and reverted — instead of a bare toast.
      const name = e instanceof Error ? e.name : "Error";
      const msg = e instanceof Error ? e.message : "Sync failed";
      const isAbort = name === "AbortError";
      setSyncDiag({
        recordingId: recId,
        stage: "upload-proxy",
        failed: true,
        blobSize,
        blobSizeMb: formatBytes(blobSize),
        mimeType: mime,
        ext,
        elapsedMs: Date.now() - startedAtMs,
        startedAt,
        httpStatus: null,
        errorKind: isAbort ? "fetch-aborted" : "network",
        errorMessage: msg,
        rawName: name,
      });
      toast.error(isAbort ? "Cloud upload timed out — see details below." : msg);
    } finally {
      setSyncing(false);
    }
  }, [qc, video.data, videoId]);

  // Re-run the cloud-object verification (present/missing/unknown) when a
  // previous attempt came back "unknown" — a transient storage/transport
  // error should not permanently leave the recording unverified.
  const handleRetryVerify = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["video-object", videoId] });
  }, [qc, videoId]);

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
          ) : cloudBinaryMissing ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
            >
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="flex-1">
                {hasLocalBlob === false
                  ? "The video file is missing from Cloud storage, and no local copy was found on this device. Open this recording on the device that created it and use “Sync to Cloud” to recover it from that device’s local copy."
                  : "The video file is missing from Cloud storage. A local copy was found on this device — sync it to Cloud so the share link works everywhere."}
              </span>
              {hasLocalBlob ? (
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
              ) : null}
            </div>
          ) : cloudBinaryUnverified ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-foreground"
            >
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="flex-1">
                Cloud status for this recording could not be verified (storage unreachable or
                returned an error). The recording is still shown — the file may exist. Try verifying
                again.
              </span>
              <button
                type="button"
                onClick={handleRetryVerify}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <CloudUpload className="size-3.5" />
                Retry verify
              </button>
            </div>
          ) : null}
          {syncDiag ? (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-foreground ring-1 ring-destructive/30"
            >
              <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span className="font-semibold text-destructive">
                  Cloud sync failed — diagnostic details
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const text = diagnosticsToText(syncDiag);
                    navigator.clipboard?.writeText(text).then(
                      () => toast.success("Diagnostic details copied"),
                      () => toast.error("Could not copy — select the text manually"),
                    );
                  }}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Copy className="size-3.5" /> Copy diagnostic details
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Copy this block and paste it back so the exact failing stage can be diagnosed. The
                text below is also selectable.
              </p>
              <pre
                aria-label="Cloud sync diagnostic details"
                className="mt-2 max-h-60 select-text overflow-auto rounded-lg border border-border/80 bg-background/80 p-3 font-mono text-[12px] leading-relaxed text-foreground"
              >
                {diagnosticsToText(syncDiag)}
              </pre>
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
