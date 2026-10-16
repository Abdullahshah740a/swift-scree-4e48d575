import { useState } from "react";
import { Link as LinkIcon, Code2, Download, Check, Clipboard } from "lucide-react";
import { toast } from "sonner";

export function ShareBar({
  videoId,
  title,
  mimeType,
  ext,
}: {
  videoId: string;
  title: string;
  mimeType: string;
  ext: string;
}) {
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);

  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/v/${videoId}` : `/v/${videoId}`;
  const embedSrc = shareUrl;
  const embedCode = `<iframe src="${embedSrc}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen" title="${title.replace(/"/g, "&quot;")}"></iframe>`;

  const copy = async (which: "link" | "embed", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast.success(which === "link" ? "Link copied" : "Embed code copied");
      setTimeout(() => setCopied(null), 1800);
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/60 p-2">
      <button
        onClick={() => copy("link", shareUrl)}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {copied === "link" ? <Check className="size-4" /> : <LinkIcon className="size-4" />}
        Copy link
      </button>
      <button
        onClick={() => copy("embed", embedCode)}
        className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        {copied === "embed" ? <Check className="size-4" /> : <Code2 className="size-4" />}
        Copy embed
      </button>
      <a
        href={`/api/video/${videoId}`}
        download={`${title.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "swift-screen"}.${ext}`}
        className="inline-flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        title={`Download .${ext}`}
      >
        <Download className="size-4" /> Download
      </a>
      <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
        <Clipboard className="size-3.5" /> {mimeType}
      </span>
    </div>
  );
}
