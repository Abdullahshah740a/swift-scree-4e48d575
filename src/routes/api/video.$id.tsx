import { createFileRoute } from "@tanstack/react-router";
import { getVideoMeta as getVideoMetaServer } from "@/lib/storage.server";

// Public, anonymous video endpoint for the watch page and chromeless share
// viewer. Three modes:
//
//  - Playback (default): 302-redirect to a short-lived signed URL so the
//    browser hits Cloud Storage's CDN directly. The CDN serves the file with
//    full byte-range support, which <video> needs.
//  - Download original (?download=1): stream the ORIGINAL recording through
//    the worker with Content-Disposition: attachment. A same-origin attachment
//    response forces a real save (browsers IGNORE <a download> for cross-origin
//    redirects). The filename uses the truthful extension (.webm / .mp4).
//  - Download MP4 (?mp4=1): stream the CONVERTED H.264/AAC derivative
//    (videos/<id>.mp4) with Content-Type: video/mp4 + a .mp4 attachment
//    filename. Only present after the browser converts and uploads it
//    (rec.mp4Path is set). This is what "Download MP4" uses so VLC can seek.

function extForMime(mime: string): string {
  return mime && mime.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

function mimeForExt(ext?: string): string {
  return ext && ext.toLowerCase() === "mp4" ? "video/mp4" : "video/webm";
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
        const mp4ObjectPath = `videos/${rec.id}.mp4`;

        let wantDownload = false;
        let wantMp4 = false;
        try {
          const sp = new URL(request.url).searchParams;
          wantDownload = sp.has("download");
          wantMp4 = sp.has("mp4");
        } catch {
          /* default to playback */
        }

        const fetchObject = async (path: string, ms = 60000): Promise<Response> => {
          const objUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          try {
            return await fetch(objUrl, {
              signal: controller.signal,
              headers: { apikey: key, Authorization: `Bearer ${key}` },
            });
          } finally {
            clearTimeout(timer);
          }
        };

        // Download MP4: stream the converted H.264/AAC derivative with
        // Content-Type: video/mp4 and a .mp4 attachment filename. Only present
        // after the browser converts and uploads it (rec.mp4Path is set).
        if (wantMp4) {
          if (!rec.mp4Path) {
            return new Response("MP4 not available yet", { status: 404 });
          }
          try {
            const objRes = await fetchObject(mp4ObjectPath);
            if (!objRes.ok || !objRes.body) {
              return new Response("MP4 missing", { status: 502 });
            }
            const headers = new Headers();
            headers.set("Content-Type", "video/mp4");
            headers.set("Content-Disposition", `attachment; filename="${slugify(rec.title)}.mp4"`);
            headers.set("Cache-Control", "private, max-age=300");
            const len = objRes.headers.get("content-length");
            if (len) headers.set("Content-Length", len);
            return new Response(objRes.body, { status: 200, headers });
          } catch {
            return new Response("MP4 unreachable", { status: 502 });
          }
        }

        // Download original: stream the original recording with a truthful
        // extension (.webm for WebM, .mp4 only for genuine MP4). Same-origin +
        // attachment forces a real save regardless of container.
        if (wantDownload) {
          try {
            const objRes = await fetchObject(objectPath);
            if (!objRes.ok || !objRes.body) {
              return new Response("Video missing", { status: 502 });
            }
            const headers = new Headers();
            const mime = rec.mimeType || mimeForExt(rec.ext);
            headers.set("Content-Type", mime);
            const filename = `${slugify(rec.title)}.${rec.ext || extForMime(rec.mimeType)}`;
            headers.set("Content-Disposition", `attachment; filename="${filename}"`);
            headers.set("Cache-Control", "private, max-age=300");
            const len = objRes.headers.get("content-length");
            if (len) headers.set("Content-Length", len);
            return new Response(objRes.body, { status: 200, headers });
          } catch {
            return new Response("Video unreachable", { status: 502 });
          }
        }

        // Playback: 302 to a signed URL (1 hour). The bucket name may contain
        // spaces, so encode it in the path.
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
