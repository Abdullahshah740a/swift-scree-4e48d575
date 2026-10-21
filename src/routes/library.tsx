import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Folder as FolderIcon, Film, Trash2, Circle, Loader2, Inbox } from "lucide-react";
import { useState } from "react";
import { VideoCard } from "@/components/video-card";
import {
  createFolderStrict,
  deleteFolderStrict,
  fetchFolders,
  fetchVideos,
  moveVideoStrict,
  removeRecording,
} from "@/lib/storage-client";
import type { Folder, VideoRecord } from "@/lib/types";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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

type FolderFilter = "all" | "unfiled" | string;

function folderName(folderId: string | null, folders: Folder[]): string {
  if (!folderId) return "Unfiled";
  return folders.find((f) => f.id === folderId)?.name ?? "Unfiled";
}

function Library() {
  const qc = useQueryClient();
  const [activeFolder, setActiveFolder] = useState<FolderFilter>("all");
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveMsg, setMoveMsg] = useState<string | null>(null);

  const folders = useQuery({ queryKey: ["folders"], queryFn: fetchFolders });
  const videos = useQuery({ queryKey: ["videos"], queryFn: fetchVideos });

  const allVideos = (videos.data ?? []) as VideoRecord[];
  const allFolders = (folders.data ?? []) as Folder[];

  // ----- Folder creation (optimistic + strict, no swallow) -----
  const createFolderMut = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => createFolderStrict(id, name),
    onMutate: async ({ id, name }) => {
      await qc.cancelQueries({ queryKey: ["folders"] });
      const prev = qc.getQueryData<Folder[]>(["folders"]);
      if (prev) {
        qc.setQueryData<Folder[]>(["folders"], [...prev, { id, name, createdAt: Date.now() }]);
      }
      return { prev };
    },
    onSuccess: (_data, { name }) => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      toast.success(`Folder “${name}” created`);
    },
    onError: (_err, { name }, ctx) => {
      if (ctx?.prev) qc.setQueryData(["folders"], ctx.prev);
      toast.error(`Could not create “${name}”. Please try again.`);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
    },
  });

  // ----- Folder deletion (preserves its recordings → Unfiled) -----
  const deleteFolderMut = useMutation({
    mutationFn: async (folderId: string) => deleteFolderStrict(folderId),
    onMutate: async (folderId) => {
      await qc.cancelQueries({ queryKey: ["folders"] });
      await qc.cancelQueries({ queryKey: ["videos"] });
      const prevFolders = qc.getQueryData<Folder[]>(["folders"]);
      const prevVideos = qc.getQueryData<VideoRecord[]>(["videos"]);
      if (prevFolders) {
        qc.setQueryData<Folder[]>(
          ["folders"],
          prevFolders.filter((f) => f.id !== folderId),
        );
      }
      if (prevVideos) {
        qc.setQueryData<VideoRecord[]>(
          ["videos"],
          prevVideos.map((v) => (v.folderId === folderId ? { ...v, folderId: null } : v)),
        );
      }
      return { prevFolders, prevVideos };
    },
    onSuccess: (_d, folderId) => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["videos"] });
      if (activeFolder === folderId) setActiveFolder("all");
      toast.success("Folder deleted. Recordings moved to Unfiled.");
    },
    onError: (_err, _folderId, ctx) => {
      if (ctx?.prevFolders) qc.setQueryData(["folders"], ctx.prevFolders);
      if (ctx?.prevVideos) qc.setQueryData(["videos"], ctx.prevVideos);
      toast.error("Could not delete folder. Please try again.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["videos"] });
    },
  });

  // ----- Video move (per-video pending + rollback only this op) -----
  const moveMut = useMutation({
    mutationFn: async ({ video, folderId }: { video: VideoRecord; folderId: string | null }) =>
      moveVideoStrict(video.id, folderId),
    onMutate: async ({ video, folderId }) => {
      // No-op if the destination is already current.
      if ((video.folderId ?? null) === folderId) return { prev: null, noOp: true };

      await qc.cancelQueries({ queryKey: ["videos"] });
      await qc.cancelQueries({ queryKey: ["video", video.id] });

      const prevVideos = qc.getQueryData<VideoRecord[]>(["videos"]);
      const prevVideo = qc.getQueryData<VideoRecord>(["video", video.id]);

      if (prevVideos) {
        qc.setQueryData<VideoRecord[]>(
          ["videos"],
          prevVideos.map((v) => (v.id === video.id ? { ...v, folderId } : v)),
        );
      }
      if (prevVideo) {
        qc.setQueryData<VideoRecord>(["video", video.id], { ...prevVideo, folderId });
      }

      setMovingId(video.id);
      return { prev: { prevVideos, prevVideo }, noOp: false };
    },
    onSuccess: (res, { video, folderId }) => {
      if (res.ok) {
        const destName = folderName(folderId, allFolders);
        toast.success(`Moved “${video.title}” to ${destName}.`);
        // Reconcile with the confirmed server record (exact values) without a full refetch.
        if (res.record) {
          const confirmed = res.record;
          const cur = qc.getQueryData<VideoRecord[]>(["videos"]);
          if (cur) {
            qc.setQueryData<VideoRecord[]>(
              ["videos"],
              cur.map((v) => (v.id === confirmed.id ? confirmed : v)),
            );
          }
          qc.setQueryData<VideoRecord>(["video", video.id], confirmed);
        }
      } else {
        // Surface the typed failure. Rollback handled in onError too, but keep the message here.
        setMoveMsg(`Move failed: ${res.message ?? "Please try again."}`);
        toast.error(res.message ?? "Could not move recording. Reverting.");
      }
    },
    onError: (_err, { video }, ctx) => {
      if (ctx?.prev?.prevVideos) qc.setQueryData(["videos"], ctx.prev.prevVideos);
      if (ctx?.prev?.prevVideo) qc.setQueryData(["video", video.id], ctx.prev.prevVideo);
      setMoveMsg(`Could not move “${video.title}”. Reverted — try again.`);
      toast.error(`Could not move “${video.title}”. Reverted.`);
    },
    onSettled: (_d, _e, { video }) => {
      setMovingId(null);
      // Clear the one-off status message after a short delay so it's readable.
      if (moveMsg) {
        const id = window.setTimeout(() => setMoveMsg(null), 4000);
        // Clear on unmount handled by GC; keep simple.
        void id;
      }
    },
  });

  const [pendingDelete, setPendingDelete] = useState<VideoRecord | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleteAllCount, setDeleteAllCount] = useState(0);
  const deleteVideoMut = useMutation({
    mutationFn: async (video: VideoRecord) => {
      await removeRecording(video.id, video.ext);
    },
    onMutate: async (video) => {
      await qc.cancelQueries({ queryKey: ["videos"] });
      const prev = qc.getQueryData<VideoRecord[]>(["videos"]);
      if (prev) {
        qc.setQueryData<VideoRecord[]>(
          ["videos"],
          prev.filter((v) => v.id !== video.id),
        );
      }
      return { prev };
    },
    onSuccess: (_d, video) => {
      qc.invalidateQueries({ queryKey: ["videos"] });
      qc.removeQueries({ queryKey: ["video", video.id] });
      toast.success("Recording deleted");
    },
    onError: (_e, video, ctx) => {
      if (ctx?.prev) qc.setQueryData(["videos"], ctx.prev);
      toast.error(`Could not delete “${video.title}”. Restored — try again.`);
    },
  });

  // ----- Delete all videos (bulk) -----
  const deleteAllVideosMut = useMutation({
    mutationFn: async (videos: VideoRecord[]) => {
      // Delete every recording from cloud + local, preserving folders.
      // Map to their results so the UI can report an honest count.
      const results = await Promise.allSettled(videos.map((v) => removeRecording(v.id, v.ext)));
      const okCount = results.filter((r) => r.status === "fulfilled").length;
      return { okCount, total: videos.length };
    },
    onMutate: async (videos) => {
      await qc.cancelQueries({ queryKey: ["videos"] });
      const prevVideos = qc.getQueryData<VideoRecord[]>(["videos"]);
      // Optimistically remove every video; folders are preserved.
      qc.setQueryData<VideoRecord[]>(["videos"], []);
      return { prevVideos };
    },
    onSuccess: ({ okCount, total }) => {
      qc.invalidateQueries({ queryKey: ["videos"] });
      if (okCount === total) {
        toast.success(`Deleted ${total} recording${total === 1 ? "" : "s"}.`);
      } else {
        toast.error(`Deleted ${okCount} of ${total}. Some failed — try again.`);
      }
    },
    onError: (_err, _videos, ctx) => {
      if (ctx?.prevVideos) qc.setQueryData(["videos"], ctx.prevVideos);
      toast.error("Could not delete all recordings. Please try again.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["videos"] });
      setConfirmDeleteAll(false);
      setDeleteAllCount(0);
    },
  });
  const unfiledCount = allVideos.filter((v) => !v.folderId).length;
  const folderCount = (fid: string) => allVideos.filter((v) => v.folderId === fid).length;

  const shown =
    activeFolder === "all"
      ? allVideos
      : activeFolder === "unfiled"
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
        <div className="flex items-center gap-2">
          {allVideos.length > 0 ? (
            <button
              type="button"
              disabled={deleteAllVideosMut.isPending}
              onClick={() => {
                setDeleteAllCount(allVideos.length);
                setConfirmDeleteAll(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-semibold text-destructive transition-transform hover:scale-[1.02] hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash2 className="size-4" /> Delete all videos
            </button>
          ) : null}
          <Link
            to="/record"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
          >
            <Circle className="size-4 fill-current" /> New recording
          </Link>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">Folders</h2>
            <NewFolderButton
              onCreate={({ id, name }) => createFolderMut.mutate({ id, name })}
              pending={createFolderMut.isPending}
            />
          </div>
          <div className="mt-2 flex flex-col gap-1">
            <FolderRow
              active={activeFolder === "all"}
              onClick={() => setActiveFolder("all")}
              label="All recordings"
              count={allVideos.length}
            />
            <FolderRow
              active={activeFolder === "unfiled"}
              onClick={() => setActiveFolder("unfiled")}
              label="Unfiled"
              count={unfiledCount}
              icon={<Inbox className="size-4 shrink-0" />}
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
                  <span className="ml-auto text-xs text-muted-foreground">{folderCount(f.id)}</span>
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
          {moveMsg ? (
            <div
              role="status"
              aria-live="polite"
              className="mb-3 rounded-lg border border-border/60 bg-card/70 px-3 py-2 text-sm text-muted-foreground"
            >
              {moveMsg}
            </div>
          ) : null}
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
              <p className="mt-3 text-sm font-medium text-foreground">
                {activeFolder === "all" ? "Nothing here yet" : "No recordings in this view"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeFolder === "all"
                  ? "Your recordings will show up here."
                  : "Recordings in this folder will show up here."}
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
                  onDelete={(vid) => setPendingDelete(vid)}
                  onMove={(vid, fid) => moveMut.mutate({ video: vid, folderId: fid })}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `“${pendingDelete.title}” will be permanently removed from both this device and the shared library. This cannot be undone.`
                : "This recording will be permanently removed. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteVideoMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteVideoMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (pendingDelete)
                  deleteVideoMut.mutate(pendingDelete, { onSuccess: () => setPendingDelete(null) });
              }}
            >
              {deleteVideoMut.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Deleting…
                </span>
              ) : (
                "Delete recording"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmDeleteAll}
        onOpenChange={(open) => {
          if (!open && !deleteAllVideosMut.isPending) {
            setConfirmDeleteAll(false);
            setDeleteAllCount(0);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete all {deleteAllCount} recording{deleteAllCount === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every recording in this library will be permanently removed from both this device and
              the shared library — including their videos, comments, reactions, and transcripts.
              Folders are preserved. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAllVideosMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteAllVideosMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (allVideos.length) deleteAllVideosMut.mutate(allVideos);
              }}
            >
              {deleteAllVideosMut.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Deleting…
                </span>
              ) : (
                `Delete all ${deleteAllCount} recording${deleteAllCount === 1 ? "" : "s"}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FolderRow({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
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
      {icon ?? <FolderIcon className="size-4 shrink-0" />}
      <span className="truncate">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

function NewFolderButton({
  onCreate,
  pending,
}: {
  onCreate: (input: { id: string; name: string }) => void;
  pending: boolean;
}) {
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
        const trimmed = name.trim();
        if (!trimmed) return;
        // Stable id generated client-side so a retry never duplicates.
        onCreate({ id: crypto.randomUUID(), name: trimmed });
        // Keep the form open until persistence resolves: on success the
        // mutation settles and we clear; on failure the user keeps their name.
      }}
    >
      <input
        autoFocus
        value={name}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        placeholder="Folder name"
        maxLength={100}
        className="w-28 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {pending ? "Creating…" : "Add"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setName("");
          setOpen(false);
        }}
        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
      >
        Cancel
      </button>
    </form>
  );
}
