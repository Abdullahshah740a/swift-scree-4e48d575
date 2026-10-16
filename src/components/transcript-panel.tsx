import { useState } from "react";
import { FileText, Loader2, Sparkles, Clock } from "lucide-react";
import type { Transcript, TranscriptSegment } from "@/lib/types";
import { formatDuration } from "@/lib/format";

interface Props {
  transcript: Transcript | null;
  generating: boolean;
  progress: { pct: number; msg: string } | null;
  onGenerate: () => void;
  onSeek: (t: number) => void;
}

export function TranscriptPanel({ transcript, generating, progress, onGenerate, onSeek }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const segments: TranscriptSegment[] = transcript?.segments ?? [];

  return (
    <div className="flex h-full flex-col rounded-xl border border-border/60 bg-card/60">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <FileText className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Transcript</h3>
        {!transcript && !generating ? (
          <button
            onClick={onGenerate}
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/25"
          >
            <Sparkles className="size-3.5" /> Generate
          </button>
        ) : null}
        {generating ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {progress?.msg ?? "…"}
          </span>
        ) : null}
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {segments.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {generating ? "Running Whisper in your browser…" : "No transcript yet."}
          </p>
        ) : (
          segments.map((seg, i) => (
            <button
              key={i}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onClick={() => onSeek(seg.start)}
              className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/20"
              style={
                active === i
                  ? { background: "color-mix(in oklab, var(--primary) 10%, transparent)" }
                  : undefined
              }
            >
              <span className="mr-2 inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                <Clock className="size-3" />
                {formatDuration(seg.start)}
              </span>
              <span className="text-sm text-foreground">{seg.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
