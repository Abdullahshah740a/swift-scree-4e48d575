import { createFileRoute } from "@tanstack/react-router";
import { Download, Clapperboard, FileVideo, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { WatchContent } from "@/components/watch-content";
import {
  fetchVideoMeta,
  triggerVideoDownload,
  triggerVideoDownloadOriginal,
  type DownloadProgress,
} from "@/lib/storage-client";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/v/$id")({
  head: ({ params }) => ({
    meta: [
      { title: "Swift Screen — Shared Video" },
      {
        name: "description",
        content: `Watch this shared Swift Screen recording: ${params.id}.`,
      },
      { property: "og:title", content: "Swift Screen — Shared Video" },
      {
        property: "og:description",
        content: "Watch this shared async recording — no sign-in required.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ViewerPage,
});

function ViewerPage() {
  const { id } = Route.useParams();
  const { data, isLoading } = useQuery({
    queryKey: ["video", id],
    queryFn: () => fetchVideoMeta(id),
  });
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadingOrig, setDownloadingOrig] = useState(false);

  const handleDownloadMp4 = async () => {
    if (!data || downloading) return;
    setDownloading(true);
    setProgress({ pct: 0, msg: "Preparing MP4…" });
    try {
      await triggerVideoDownload(data, (p) => setProgress(p));
      toast.success("Downloading MP4…");
    } catch (e) {
      toast.error("Could not prepare MP4 download");
      console.error("[v] mp4 download failed", e);
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  const handleDownloadOriginal = async () => {
    if (!data || downloadingOrig) return;
    setDownloadingOrig(true);
    try {
      await triggerVideoDownloadOriginal(data);
      toast.success("Downloading original…");
    } catch (e) {
      toast.error("Could not start download");
      console.error("[v] original download failed", e);
    } finally {
      setDownloadingOrig(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <Clapperboard className="size-10 text-primary/60" />
        <h1 className="text-lg font-semibold text-foreground">Video unavailable</h1>
        <p className="text-sm text-muted-foreground">
          This recording can't be found. Cloud storage may not be configured, or it was recorded on
          another device and not yet synced.
        </p>
      </div>
    );
  }

  const mp4Label = progress
    ? progress.pct >= 100
      ? "Starting download…"
      : `${progress.msg} ${progress.pct}%`
    : downloading
      ? "Preparing MP4…"
      : "Download MP4";

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Clapperboard className="size-4 text-primary" />
          <span className="font-semibold text-foreground">Swift Screen</span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadMp4}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
              title="Download MP4 (H.264, seekable in VLC)"
            >
              {downloading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {mp4Label}
            </button>
            <button
              type="button"
              onClick={handleDownloadOriginal}
              disabled={downloadingOrig}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
              title={`Download original (.${data.ext || "webm"})`}
            >
              <FileVideo className="size-3.5" /> {downloadingOrig ? "Downloading…" : "Original"}
            </button>
          </span>
        </div>
        <WatchContent videoId={id} chromeless authorName="Viewer" />
      </div>
    </div>
  );
}
