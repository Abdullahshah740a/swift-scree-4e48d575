import { createFileRoute } from "@tanstack/react-router";
import { getVideoMeta as getVideoMetaServer } from "@/lib/storage.server";

// Public, anonymous video endpoint for the watch page and chromeless share
// viewer. Instead of buffering the whole file through the Edge worker (which
// advertises Accept-Ranges but can't honor Range requests, so Chrome/Firefox
// refuse to play WebM with "No video with supported format and MIME type"),
// we create a short-lived signed URL for the private object and 302-redirect
// the browser to Cloud Storage's CDN. The CDN serves the file with full
// streaming + byte-range support, so <video> decodes it reliably.

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

        const objectPath = `videos/${rec.id}.${rec.ext}`;
        // Create a signed URL (1 hour). The bucket name may contain spaces, so
        // encode it in the path. The object path segments are encoded too.
        const signPath = `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeURIComponent(objectPath)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        try {
          const res = await fetch(`${url}${signPath}`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ expiresIn: 3600 }),
          });
          if (!res.ok) {
            return new Response("Video missing", { status: 502 });
          }
          const data = (await res.json()) as { signedURL?: string };
          const signed = data.signedURL;
          if (!signed) {
            return new Response("Video missing", { status: 502 });
          }
          // signedURL may be relative ("/storage/v1/...") or absolute.
          const target = signed.startsWith("http")
            ? signed
            : `${url}${signed.startsWith("/") ? "" : "/"}${signed}`;
          return new Response(null, {
            status: 302,
            headers: {
              Location: target,
              "Cache-Control": "private, max-age=300",
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
