import { createFileRoute } from "@tanstack/react-router";
import { Download, Clapperboard } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { WatchContent } from "@/components/watch-content";
import { fetchVideoMeta, triggerVideoDownload } from "@/lib/storage-client";
import { Loader2 } from "lucide-react";
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

  const handleDownload = async () => {
    if (!data) return;
    setDownloading(true);
    try {
      await triggerVideoDownload(data);
      toast.success(`Downloading ${data.ext || "webm"}…`);
    } catch {
      toast.error("Could not start download");
    } finally {
      setDownloading(false);
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

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Clapperboard className="size-4 text-primary" />
          <span className="font-semibold text-foreground">Swift Screen</span>
          <span className="ml-auto">
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
              title={`Download .${data.ext || "webm"}`}
            >
              <Download className="size-3.5" /> {downloading ? "Downloading…" : "Download"}
            </button>
          </span>
        </div>
        <WatchContent videoId={id} chromeless authorName="Viewer" />
      </div>
    </div>
  );
}
