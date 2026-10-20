import { useState } from "react";
import {
  Link as LinkIcon,
  Code2,
  Download,
  Check,
  Clipboard,
  Trash2,
  FileVideo,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import {
  triggerVideoDownload,
  triggerVideoDownloadOriginal,
  type DownloadProgress,
} from "@/lib/storage-client";
import type { VideoRecord } from "@/lib/types";

export function ShareBar({
  video,
  onDelete,
}: {
  video: VideoRecord;
  onDelete?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadingOrig, setDownloadingOrig] = useState(false);

  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/v/${video.id}` : `/v/${video.id}`;
  const embedSrc = shareUrl;
  const embedCode = `<iframe src="${embedSrc}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen" title="${video.title.replace(/"/g, "&quot;")}"></iframe>`;

  const copy = async (which: "link" | "embed", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast.success(which === "link" ? "Link copied" : "Embed code copied");
      setTimeout(() => setCopied(null), 1800);
    } catch {
      toast.error("Could not copy");
    }
  };

  const handleDownloadMp4 = async () => {
    if (downloading) return;
    setDownloading(true);
    setProgress({ pct: 0, msg: "Preparing MP4…" });
    try {
      await triggerVideoDownload(video, (p) => setProgress(p));
      toast.success("Downloading MP4…");
    } catch (e) {
      toast.error("Could not prepare MP4 download");
      console.error("[share-bar] mp4 download failed", e);
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  const handleDownloadOriginal = async () => {
    if (downloadingOrig) return;
    setDownloadingOrig(true);
    try {
      await triggerVideoDownloadOriginal(video);
      toast.success("Downloading original…");
    } catch (e) {
      toast.error("Could not start download");
      console.error("[share-bar] original download failed", e);
    } finally {
      setDownloadingOrig(false);
    }
  };

  const mp4Label = progress
    ? progress.pct >= 100
      ? "Starting download…"
      : `${progress.msg} ${progress.pct}%`
    : downloading
      ? "Preparing MP4…"
      : "Download MP4";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/60 p-2">
      <button
        onClick={() => copy("link", shareUrl)}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {copied === "link" ? <Check className="size-4" /> : <LinkIcon className="size-4" />}
        Copy link
      </button>
      <button
        onClick={() => copy("embed", embedCode)}
        className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        {copied === "embed" ? <Check className="size-4" /> : <Code2 className="size-4" />}
        Copy embed
      </button>
      <button
        type="button"
        onClick={handleDownloadMp4}
        disabled={downloading}
        className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        title="Download MP4 (H.264, seekable in VLC)"
      >
        {downloading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        {mp4Label}
      </button>
      <button
        type="button"
        onClick={handleDownloadOriginal}
        disabled={downloadingOrig}
        className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        title={`Download original (.${video.ext || "webm"})`}
      >
        <FileVideo className="size-4" /> {downloadingOrig ? "Downloading…" : "Original"}
      </button>
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
          title="Delete recording"
        >
          <Trash2 className="size-4" /> Delete
        </button>
      ) : null}
      <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
        <Clipboard className="size-3.5" /> {video.mimeType}
      </span>
    </div>
  );
}
