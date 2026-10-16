import { Link } from "@tanstack/react-router";
import {
  Film,
  Monitor,
  Camera,
  MonitorSpeaker,
  MoreVertical,
  Trash2,
  FolderInput,
  Eye,
  Clock,
} from "lucide-react";
import type { Folder, VideoRecord } from "@/lib/types";
import { formatDuration, formatRelativeTime, sourceTypeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SourceIcon } from "./source-icon";

export function VideoCard({
  video,
  folders,
  onDelete,
  onMove,
  compact,
}: {
  video: VideoRecord;
  folders: Folder[];
  onDelete?: ((video: VideoRecord) => void) | undefined;
  onMove?: ((video: VideoRecord, folderId: string | null) => void) | undefined;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-xl border border-border/60 bg-card/70 transition-colors hover:border-primary/40",
        compact ? "flex items-center gap-3 pr-2" : "overflow-hidden",
      )}
    >
      <Link
        to="/watch/$id"
        params={{ id: video.id }}
        className={cn(compact ? "flex flex-1 items-center gap-3 p-2.5" : "block")}
      >
        <div
          className={cn(
            "relative overflow-hidden bg-background/80",
            compact ? "size-20 shrink-0 rounded-lg" : "aspect-video w-full",
          )}
        >
          {video.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={video.thumbnail}
              alt={video.title}
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <Film className="size-6" />
            </div>
          )}
          <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground backdrop-blur">
            {formatDuration(video.duration)}
          </span>
        </div>
        {compact ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{video.title}</p>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <SourceIcon type={video.sourceType} className="size-3" />
              {sourceTypeLabel(video.sourceType)}
              <span className="inline-flex items-center gap-1">
                <Eye className="size-3" /> {video.views}
              </span>
              <span>{formatRelativeTime(video.createdAt)}</span>
            </p>
          </div>
        ) : null}
      </Link>

      {!compact && (
        <div className="p-3">
          <div className="flex items-start justify-between gap-2">
            <Link to="/watch/$id" params={{ id: video.id }} className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{video.title}</p>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <SourceIcon type={video.sourceType} className="size-3" />
                {sourceTypeLabel(video.sourceType)}
              </p>
            </Link>
            {onDelete || onMove ? (
              <CardMenu video={video} folders={folders} onDelete={onDelete} onMove={onMove} />
            ) : null}
          </div>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Eye className="size-3" /> {video.views} views
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" /> {formatRelativeTime(video.createdAt)}
            </span>
          </div>
        </div>
      )}

      {(onDelete || onMove) && compact ? (
        <CardMenu video={video} folders={folders} onDelete={onDelete} onMove={onMove} compact />
      ) : null}
    </div>
  );
}

function CardMenu({
  video,
  folders,
  onDelete,
  onMove,
  compact,
}: {
  video: VideoRecord;
  folders: Folder[];
  onDelete?: ((video: VideoRecord) => void) | undefined;
  onMove?: ((video: VideoRecord, folderId: string | null) => void) | undefined;
  compact?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <details className="group/menu">
        <summary
          className={cn(
            "flex size-8 cursor-pointer list-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground active:scale-95",
          )}
          aria-label="More actions"
        >
          <MoreVertical className="size-4" />
        </summary>
        <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl border border-border bg-popover p-1.5 text-sm shadow-2xl backdrop-blur-md">
          {onMove ? (
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Move to folder
            </div>
          ) : null}
          {onMove ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent/30 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onMove(video, null);
              }}
            >
              <FolderInput className="size-3.5 text-muted-foreground" /> No folder
            </button>
          ) : null}
          {onMove &&
            folders.map((f) => (
              <button
                key={f.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent/30 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onMove(video, f.id);
                }}
              >
                <FolderInput className="size-3.5 text-muted-foreground" /> {f.name}
              </button>
            ))}
          {onDelete ? (
            <>
              {onMove ? <div className="my-1.5 h-px bg-border/60" /> : null}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg bg-destructive/15 px-2.5 py-2 text-left text-xs font-semibold text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(video);
                }}
              >
                <Trash2 className="size-4 shrink-0 text-current" /> Delete recording
              </button>
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}

export { SourceIcon };
