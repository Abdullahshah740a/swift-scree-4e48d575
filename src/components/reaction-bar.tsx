import { Heart, ThumbsUp, Laugh, Flame, PartyPopper } from "lucide-react";
import type { Reaction } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMOJIS = [
  { emoji: "❤️", Icon: Heart, label: "Love" },
  { emoji: "👍", Icon: ThumbsUp, label: "Like" },
  { emoji: "😂", Icon: Laugh, label: "Funny" },
  { emoji: "🔥", Icon: Flame, label: "Fire" },
  { emoji: "🎉", Icon: PartyPopper, label: "Celebrate" },
];

interface Props {
  reactions: Reaction[];
  current: number;
  onAdd: (emoji: string) => void;
  onSeek?: (t: number) => void;
}

export function ReactionBar({ reactions, current, onAdd, onSeek }: Props) {
  const atCurrent = reactions.filter((r) => Math.abs(r.time - current) < 0.6);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2">
      <div className="flex items-center gap-1">
        {EMOJIS.map(({ emoji, Icon, label }) => (
          <button
            key={emoji}
            onClick={() => onAdd(emoji)}
            title={`${label} @ ${current.toFixed(1)}s`}
            className="inline-flex size-8 items-center justify-center rounded-full text-base transition-transform hover:scale-110"
            aria-label={label}
          >
            <span className="sr-only">{label}</span>
            <Icon className="size-4 text-muted-foreground opacity-70" />
          </button>
        ))}
      </div>
      {atCurrent.length > 0 ? (
        <div className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
          {atCurrent.slice(0, 5).map((r) => (
            <button
              key={r.id}
              onClick={() => onSeek?.(r.time)}
              className="rounded-full bg-background/60 px-1.5 py-0.5 hover:bg-accent/20"
            >
              {r.emoji}
            </button>
          ))}
        </div>
      ) : null}
      <span className="ml-auto text-[11px] text-muted-foreground">
        Tap an emoji to drop it at {current.toFixed(1)}s
      </span>
    </div>
  );
}

export { EMOJIS };
