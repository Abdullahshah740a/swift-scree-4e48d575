import { createFileRoute } from "@tanstack/react-router";
import { WatchContent } from "@/components/watch-content";

export const Route = createFileRoute("/watch/$id")({
  head: ({ params }) => ({
    meta: [
      { title: "Swift Screen — Watch" },
      {
        name: "description",
        content: `Watch this Swift Screen recording: ${params.id}.`,
      },
      { property: "og:title", content: "Swift Screen — Watch" },
      {
        property: "og:description",
        content: "Watch this async recording with timestamped comments.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WatchPage,
});

function WatchPage() {
  const { id } = Route.useParams();
  return <WatchContent videoId={id} />;
}
