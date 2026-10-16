import { useState } from "react";
import { MessageSquare, Send } from "lucide-react";
import type { Comment } from "@/lib/types";
import { formatDuration, formatRelativeTime } from "@/lib/format";

interface Props {
  comments: Comment[];
  current: number;
  onAdd: (text: string, time: number) => void;
  onSeek: (t: number) => void;
}

export function CommentsPanel({ comments, current, onAdd, onSeek }: Props) {
  const [text, setText] = useState("");
  const sorted = [...comments].sort((a, b) => a.time - b.time);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onAdd(text.trim(), current);
    setText("");
  };

  return (
    <div className="flex h-full flex-col rounded-xl border border-border/60 bg-card/60">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <MessageSquare className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">
          Comments {sorted.length > 0 ? `(${sorted.length})` : ""}
        </h3>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No comments yet. Add one at the current timestamp.
          </p>
        ) : (
          sorted.map((c) => (
            <button
              key={c.id}
              onClick={() => onSeek(c.time)}
              className="block w-full rounded-lg border border-border/50 bg-background/40 p-2.5 text-left transition-colors hover:border-primary/40"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                  {formatDuration(c.time)}
                </span>
                <span className="truncate text-xs font-medium text-foreground">{c.author}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {formatRelativeTime(c.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-sm text-foreground">{c.text}</p>
            </button>
          ))
        )}
      </div>
      <form onSubmit={submit} className="border-t border-border/60 p-3">
        <div className="flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Comment @ ${formatDuration(current)}…`}
            className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="inline-flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
            aria-label="Add comment"
          >
            <Send className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
