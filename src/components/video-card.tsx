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
  Loader2,
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
  moving,
}: {
  video: VideoRecord;
  folders: Folder[];
  onDelete?: ((video: VideoRecord) => void) | undefined;
  onMove?: ((video: VideoRecord, folderId: string | null) => void) | undefined;
  compact?: boolean | undefined;
  moving?: boolean | undefined;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-xl border border-border/60 bg-card/70 transition-colors hover:border-primary/40",
        compact ? "flex items-center gap-3 pr-2" : "overflow-hidden",
        moving && "pointer-events-none opacity-70",
      )}
    >
      {moving ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/40 backdrop-blur-[1px]">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : null}
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
              <CardMenu
                video={video}
                folders={folders}
                onDelete={onDelete}
                onMove={onMove}
                moving={moving}
              />
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
        <CardMenu
          video={video}
          folders={folders}
          onDelete={onDelete}
          onMove={onMove}
          compact
          moving={moving}
        />
      ) : null}
    </div>
  );
}

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function CardMenu({
  video,
  folders,
  onDelete,
  onMove,
  compact,
  moving,
}: {
  video: VideoRecord;
  folders: Folder[];
  onDelete?: ((video: VideoRecord) => void) | undefined;
  onMove?: ((video: VideoRecord, folderId: string | null) => void) | undefined;
  compact?: boolean | undefined;
  moving?: boolean | undefined;
}) {
  return (
    <div className="relative shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="More actions"
            disabled={moving}
            onClick={(e) => e.stopPropagation()}
          >
            {moving ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <MoreVertical className="size-4" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={6}
          className="w-52 p-1.5 z-[100]"
        >
          {onMove ? (
            <>
              <DropdownMenuLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Move to folder
              </DropdownMenuLabel>
              <DropdownMenuItem
                className="cursor-pointer gap-2 px-2.5 py-1.5 text-xs font-medium"
                onClick={(e) => {
                  e.stopPropagation();
                  onMove(video, null);
                }}
              >
                <FolderInput className="size-3.5 text-muted-foreground" /> No folder
              </DropdownMenuItem>
              {folders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  className="cursor-pointer gap-2 px-2.5 py-1.5 text-xs font-medium"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(video, f.id);
                  }}
                >
                  <FolderInput className="size-3.5 text-muted-foreground" /> {f.name}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}

          {onDelete ? (
            <>
              {onMove ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                className="cursor-pointer gap-2 rounded-lg bg-destructive/15 px-2.5 py-2 text-xs font-semibold text-destructive focus:bg-destructive focus:text-destructive-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(video);
                }}
              >
                <Trash2 className="size-4 shrink-0" /> Delete recording
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export { SourceIcon };
