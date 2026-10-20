import { createFileRoute } from "@tanstack/react-router";
import { getVideoMeta as getVideoMetaServer, objectExists } from "@/lib/storage.server";

// Public, anonymous video endpoint for the watch page and chromeless share
// viewer. Two modes:
//  - Playback (default): 302-redirect to a short-lived signed URL so the
//    browser hits Cloud Storage's CDN directly. The CDN serves the file with
//    full byte-range support, which <video> needs.
//  - Download (?download=1): stream the object THROUGH the worker with
//    Content-Disposition: attachment (same-origin so the browser saves it
//    rather than navigating to a cross-origin URL).
//
// This handler distinguishes three honest outcomes:
//  - Metadata missing -> 404 ("Not found")
//  - Metadata present but Cloud bytes missing/unverified -> 404 with a body
//    that names the actual cause ("video file is missing in Cloud"), so the
//    player can show "this recording is local-only on the device that made
//    it" instead of a generic "could not be decoded" message.
//  - Cloud reachable and bytes present -> 302 to the signed URL / attachment.
//  - Cloud unreachable (network/timeout) -> 502 ("Video unreachable").

function extForMime(mime: string): string {
  return mime && mime.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

/** Truthful Content-Type from the recording's actual MIME — never a bare ext. */
function mimeForExt(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("mp4")) return "video/mp4";
  if (m.includes("webm")) return "video/webm";
  if (m === "video/quicktime") return "video/mp4";
  if (m.startsWith("video/")) return m;
  return "video/webm";
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
        const contentType = mimeForExt(rec.mimeType);

        const wantDownload = request
          ? (() => {
              try {
                return new URL(request.url).searchParams.has("download");
              } catch {
                return false;
              }
            })()
          : false;

        // Verify the Cloud bytes are actually present before offering a
        // stream or signed URL. A recording whose metadata exists but whose
        // upload never completed must NOT be served as a broken 302/200 that
        // the player then reports as a decode error on a different device.
        const exists = await objectExists(objectPath);
        if (!exists) {
          // Distinguish "Cloud configured but object missing" from a
          // transport failure using the bucket reachability implied by the
          // earlier objectExists fetch. We return 404 either way because the
          // honest answer to a viewer is "no shareable file"; the watch page
          // surfaces "local only" when the record says so.
          return new Response(
            "Video file is missing in Cloud storage. It may only be available on the device that recorded it.",
            { status: 404 },
          );
        }

        if (wantDownload) {
          // Stream the object through the worker with a same-origin
          // attachment response. The truth Content-Type lets the OS pick the
          // right player; the download filename is honest about the
          // container (.webm for WebM, .mp4 for genuine MP4).
          const objUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(objectPath)}`;
          const controller = new AbortController();
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
            headers.set("Content-Type", contentType);
            const filename = `${slugify(rec.title)}.${rec.ext || extForMime(rec.mimeType)}`;
            headers.set("Content-Disposition", `attachment; filename="${filename}"`);
            headers.set("Cache-Control", "private, max-age=300");
            headers.set("Accept-Ranges", "bytes");
            const len = objRes.headers.get("content-length");
            if (len) headers.set("Content-Length", len);
            clearTimeout(timer);
            return new Response(objRes.body, { status: 200, headers });
          } catch {
            return new Response("Video unreachable", { status: 502 });
          } finally {
            clearTimeout(timer);
          }
        }

        // Playback: 302 to a signed URL (1 hour). The bucket name may contain
        // spaces, so encode it in the path. The CDN serves range requests.
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
