import { createFileRoute } from "@tanstack/react-router";
import { getVideoMeta as getVideoMetaServer } from "@/lib/storage.server";

// Public, anonymous video endpoint for the watch page and chromeless share
// viewer.
//
// Two modes:
//  - Playback (default): 302-redirect to a short-lived signed URL so the
//    browser hits Cloud Storage's CDN directly. The CDN serves the file with
//    full byte-range support, which <video> needs (the Edge worker can't honor
//    Range requests, so a proxied body makes Chrome/Firefox refuse to decode
//    WebM with "No video with supported format and MIME type").
//  - Download (?download=1): stream the object THROUGH the Edge worker with
//    Content-Disposition: attachment. The response is same-origin, so the
//    browser saves the file instead of navigating to it. A plain signed-URL
//    302 is cross-origin, and browsers IGNORE the <a download> attribute for
//    cross-origin navigations — which is exactly why the download button
//    wasn't downloading. The same-origin attachment response is the reliable
//    fix; the client (triggerVideoDownload) additionally prefers the local
//    IndexedDB blob, which is the only copy that exists for local-only
//    recordings whose cloud blob upload fell over.

function extForMime(mime: string): string {
  return mime && mime.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

function slugify(title: string): string {
  return (
    (title || "swift-screen")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .toLowerCase()
      .slice(0, 80) || "swift-screen"
  );
}

export const Route = createFileRoute("/api/video/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
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

        const wantDownload = request
          ? (() => {
              try {
                return new URL(request.url).searchParams.has("download");
              } catch {
                return false;
              }
            })()
          : false;

        if (wantDownload) {
          // Stream the object through the worker with Content-Disposition:
          // attachment. Same-origin + attachment forces a real download
          // regardless of container. Direct object GET with the service role
          // key (no signed-URL round-trip, no expiry edge cases).
          const objUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(objectPath)}`;
          const controller = new AbortController();
          // Generous: a download transfer may legitimately take a while; the
          // timer only guards header fetch, the body streams after.
          const timer = setTimeout(() => controller.abort(), 60000);
          try {
            const objRes = await fetch(objUrl, {
              signal: controller.signal,
              headers: { apikey: key, Authorization: `Bearer ${key}` },
            });
            if (!objRes.ok || !objRes.body) {
              return new Response("Video missing", { status: 502 });
            }
            const headers = new Headers();
            headers.set("Content-Type", rec.mimeType || extForMime(rec.mimeType));
            const filename = `${slugify(rec.title)}.${rec.ext || extForMime(rec.mimeType)}`;
            headers.set("Content-Disposition", `attachment; filename="${filename}"`);
            headers.set("Cache-Control", "private, max-age=300");
            const len = objRes.headers.get("content-length");
            if (len) headers.set("Content-Length", len);
            // Don't clear the timer in `finally` — clearing it here is fine
            // (clearing the timer only cancels the timeout, it does NOT abort
            // the already-returned streaming body).
            clearTimeout(timer);
            return new Response(objRes.body, { status: 200, headers });
          } catch {
            return new Response("Video unreachable", { status: 502 });
          } finally {
            clearTimeout(timer);
          }
        }

        // Playback mode: 302 to a signed URL (1 hour). The bucket name may
        // contain spaces, so encode it in the path.
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
