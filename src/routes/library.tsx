import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Folder as FolderIcon, Film, Trash2, Circle } from "lucide-react";
import { useState } from "react";
import { VideoCard } from "@/components/video-card";
import {
  fetchFolders,
  fetchVideos,
  persistFolders,
  persistVideoMeta,
  removeRecording,
} from "@/lib/storage-client";
import type { Folder, VideoRecord } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Swift Screen — Library" },
      {
        name: "description",
        content: "All your Swift Screen recordings and folders.",
      },
      { property: "og:title", content: "Swift Screen — Library" },
      {
        property: "og:description",
        content: "All your Swift Screen recordings and folders.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Library,
});

function Library() {
  const qc = useQueryClient();
  const [activeFolder, setActiveFolder] = useState<string | "all">("all");
  const [movingId, setMovingId] = useState<string | null>(null);

  const folders = useQuery({ queryKey: ["folders"], queryFn: fetchFolders });
  const videos = useQuery({ queryKey: ["videos"], queryFn: fetchVideos });

  const allVideos = videos.data ?? [];
  const allFolders = folders.data ?? [];

  const deleteFolderMut = useMutation({
    mutationFn: async (folderId: string) => {
      const next = allFolders.filter((f) => f.id !== folderId);
      await persistFolders(next);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["videos"] });
      setActiveFolder("all");
      toast.success("Folder deleted");
    },
  });

  const createFolderMut = useMutation({
    mutationFn: async (name: string) => {
      const folder: Folder = {
        id: crypto.randomUUID(),
        name,
        createdAt: Date.now(),
      };
      await persistFolders([...allFolders, folder]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      toast.success("Folder created");
    },
  });

  const moveMut = useMutation({
    mutationFn: async ({ video, folderId }: { video: VideoRecord; folderId: string | null }) => {
      const updated = { ...video, folderId };
      // Persist both locally (instant cache) and to cloud (best-effort).
      await persistVideoMeta(updated);
    },
    onMutate: async ({ video, folderId }) => {
      setMovingId(video.id);
      // Optimistically update the cache so the card moves instantly.
      await qc.cancelQueries({ queryKey: ["videos"] });
      const prev = qc.getQueryData<VideoRecord[]>(["videos"]);
      if (prev) {
        qc.setQueryData<VideoRecord[]>(
          ["videos"],
          prev.map((v) => (v.id === video.id ? { ...v, folderId } : v)),
        );
      }
      return { prev };
    },
    onSuccess: () => {
      toast.success("Moved to folder");
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["videos"], ctx.prev);
      toast.error("Could not move video — try again");
    },
    onSettled: () => {
      setMovingId(null);
      qc.invalidateQueries({ queryKey: ["videos"] });
    },
  });

  const deleteVideoMut = useMutation({
    mutationFn: async (video: VideoRecord) => {
      await removeRecording(video.id, video.ext);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["videos"] });
      toast.success("Recording deleted");
    },
  });

  const shown =
    activeFolder === "all"
      ? allVideos.filter((v) => !v.folderId)
      : allVideos.filter((v) => v.folderId === activeFolder);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {allVideos.length} recording{allVideos.length === 1 ? "" : "s"} · {allFolders.length}{" "}
            folder{allFolders.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link
          to="/record"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
        >
          <Circle className="size-4 fill-current" /> New recording
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">Folders</h2>
            <NewFolderButton onCreate={(name) => createFolderMut.mutate(name)} />
          </div>
          <div className="mt-2 flex flex-col gap-1">
            <FolderRow
              active={activeFolder === "all"}
              onClick={() => setActiveFolder("all")}
              label="All recordings"
              count={allVideos.filter((v) => !v.folderId).length}
            />
            {allFolders.map((f) => (
              <div key={f.id} className="group flex items-center gap-1">
                <button
                  className="flex flex-1 items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm transition-colors"
                  style={
                    activeFolder === f.id
                      ? {
                          background: "color-mix(in oklab, var(--primary) 15%, transparent)",
                          color: "var(--primary)",
                        }
                      : { color: "var(--muted-foreground)" }
                  }
                  onClick={() => setActiveFolder(f.id)}
                >
                  <FolderIcon className="size-4 shrink-0" />
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {allVideos.filter((v) => v.folderId === f.id).length}
                  </span>
                </button>
                <button
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => deleteFolderMut.mutate(f.id)}
                  aria-label={`Delete ${f.name}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </aside>

        <div>
          {videos.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-44 animate-pulse rounded-xl border border-border/60 bg-card/40"
                />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-12 text-center">
              <Film className="mx-auto size-8 text-primary/60" />
              <p className="mt-3 text-sm font-medium text-foreground">Nothing here yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Recordings in this folder will show up here.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((v) => (
                <VideoCard
                  key={v.id}
                  video={v}
                  folders={allFolders}
                  moving={movingId === v.id}
                  onDelete={(vid) => deleteVideoMut.mutate(vid)}
                  onMove={(vid, fid) => moveMut.mutate({ video: vid, folderId: fid })}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderRow({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
      style={
        active
          ? {
              background: "color-mix(in oklab, var(--primary) 15%, transparent)",
              color: "var(--primary)",
            }
          : { color: "var(--muted-foreground)" }
      }
    >
      <FolderIcon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

function NewFolderButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) {
    return (
      <button
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" /> New
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onCreate(name.trim());
          setName("");
          setOpen(false);
        }
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Folder name"
        className="w-28 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <button
        type="submit"
        className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
      >
        Add
      </button>
    </form>
  );
}
