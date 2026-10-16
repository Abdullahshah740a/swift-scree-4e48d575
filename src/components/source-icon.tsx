import { Monitor, Camera, MonitorSpeaker } from "lucide-react";
import type { SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SourceIcon({ type, className }: { type: SourceType; className?: string }) {
  const Icon = type === "screen" ? Monitor : type === "camera" ? Camera : MonitorSpeaker;
  return <Icon className={cn("size-4", className)} />;
}
