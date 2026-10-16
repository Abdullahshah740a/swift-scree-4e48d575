import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Circle, Film, Eye, Clock, Clapperboard, ArrowRight } from "lucide-react";
import { StorageBanner } from "@/components/storage-banner";
import { VideoCard } from "@/components/video-card";
import { fetchStorageStatus, fetchVideos, fetchFolders } from "@/lib/storage-client";
import { formatDuration } from "@/lib/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Swift Screen — Dashboard" },
      {
        name: "description",
        content: "Your async recording dashboard: storage status, stats, and recent videos.",
      },
      { property: "og:title", content: "Swift Screen — Dashboard" },
      {
        property: "og:description",
        content: "Your async recording dashboard: stats and recent videos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const status = useQuery({
    queryKey: ["storage-status"],
    queryFn: fetchStorageStatus,
  });
  const videos = useQuery({ queryKey: ["videos"], queryFn: fetchVideos });
  const folders = useQuery({ queryKey: ["folders"], queryFn: fetchFolders });

  const all = videos.data ?? [];
  const totalViews = all.reduce((s, v) => s + v.views, 0);
  const totalLength = all.reduce((s, v) => s + v.duration, 0);
  const recent = all.slice(0, 6);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              Internal tool
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">
              Recording Dashboard
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Record your screen and camera, then share async.
            </p>
          </div>
          <Link
            to="/record"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-transform hover:scale-[1.02]"
          >
            <Circle className="size-4 fill-current" /> New recording
          </Link>
        </div>

        <StorageBanner status={status.data ?? null} />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat
            label="Recordings"
            value={all.length.toString()}
            icon={<Film className="size-4" />}
          />
          <Stat
            label="Total views"
            value={totalViews.toString()}
            icon={<Eye className="size-4" />}
          />
          <Stat
            label="Total length"
            value={formatDuration(totalLength)}
            icon={<Clock className="size-4" />}
          />
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Recent</h2>
            {all.length > 0 ? (
              <Link
                to="/library"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                View library <ArrowRight className="size-3.5" />
              </Link>
            ) : null}
          </div>

          {videos.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-40 animate-pulse rounded-xl border border-border/60 bg-card/40"
                />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <EmptyState />
          ) : recent.length <= 3 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((v) => (
                <VideoCard key={v.id} video={v} folders={folders.data ?? []} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {recent.map((v) => (
                <VideoCard key={v.id} video={v} folders={folders.data ?? []} compact />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-primary">{icon}</span>
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-10 text-center">
      <Clapperboard className="mx-auto size-10 text-primary/70" />
      <p className="mt-3 text-sm font-medium text-foreground">No recordings yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Hit record to capture your first screen or camera video.
      </p>
      <Link
        to="/record"
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <Circle className="size-4 fill-current" /> Start recording
      </Link>
    </div>
  );
}
