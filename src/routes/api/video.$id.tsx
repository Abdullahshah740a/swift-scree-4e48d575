import { createFileRoute } from "@tanstack/react-router";
import { getVideoMeta as getVideoMetaServer } from "@/lib/storage.server";

// Public, anonymous video proxy: streams the stored blob for the public
// viewer and watch page. Reads from Supabase Storage using the service role.
// No auth on this edge route by design (share links are public).

export const Route = createFileRoute("/api/video/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = (params as { id: string }).id;
        const rec = await getVideoMetaServer(id);
        if (!rec) {
          return new Response("Not found", { status: 404 });
        }
        const url = process.env["SUPABASE_URL"] ?? "";
        const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
        const bucket = process.env["SUPABASE_BUCKET"] ?? "";
        if (!url || !key || !bucket) {
          return new Response("Storage not configured", { status: 502 });
        }
        const path = `videos/${rec.id}.${rec.ext}`;
        const remote = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        try {
          const res = await fetch(remote, {
            signal: controller.signal,
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });
          if (!res.ok) return new Response("Video missing", { status: 502 });
          const arrayBuf = await res.arrayBuffer();
          return new Response(arrayBuf, {
            status: 200,
            headers: {
              "content-type": rec.mimeType,
              "cache-control": "public, max-age=3600",
            },
          });
        } catch {
          return new Response("Video unreachable", { status: 502 });
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
