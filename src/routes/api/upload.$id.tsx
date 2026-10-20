import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  saveVideoMeta as saveVideoMetaServer,
  getVideoMeta as getVideoMetaServer,
} from "@/lib/storage.server";
import type { VideoRecord } from "@/lib/types";

// Same-origin upload proxy for raw recording bytes.
//
// WHY this exists: the browser cannot PUT directly to the Cloud Storage signed
// upload URL unless the bucket has explicit CORS rules allowing the app's
// origin — which the platform does not guarantee and we cannot set from here.
// Routing the upload through the Edge worker as base64-over-RPC also fails for
// any real recording (it exceeds the worker payload/serialization limit).
//
// This route receives the raw video bytes as a same-origin POST, forwards them
// straight to Cloud Storage using the service-role key (server-side only), and
// then persists the metadata JSON — so "Saved to Cloud" is only ever returned
// when BOTH the video object and its metadata actually exist. The key never
// reaches the browser, there's no CORS preflight on the app origin, and the
// bytes are streamed (not base64-bloated, not Seroval-serialized).

function env() {
  return {
    url: process.env["SUPABASE_URL"] ?? "",
    key: process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "",
    bucket: process.env["SUPABASE_BUCKET"] ?? "",
  };
}

function encodeBucket(bucket: string): string {
  return encodeURIComponent(bucket);
}

export const Route = createFileRoute("/api/upload/$id")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const id = String((params as { id?: string }).id ?? "");
        if (!id) return new Response("Missing id", { status: 400 });

        const contentType = request.headers.get("content-type") ?? "application/octet-stream";
        const expectedExt = request.headers.get("x-ext") ?? "webm";

        const { url, key, bucket } = env();
        if (!url || !key || !bucket) {
          return new Response("Storage not configured", { status: 502 });
        }

        // Validate the id is a sane path component (no path traversal).
        const idSchema = z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9_-]+$/);
        const parsed = idSchema.safeParse(id);
        if (!parsed.success) return new Response("Invalid id", { status: 400 });

        const ext = String(expectedExt).toLowerCase().endsWith("mp4") ? "mp4" : "webm";
        // `videos/<id>.<ext>` — the `/` MUST stay a literal path separator.
        // encodeURIComponent("videos/<id>.<ext>") encodes the `/` to %2F, and
        // the Storage object endpoint signs/stores `videos%2F<id>.<ext>` as a
        // single flat segment — the object ends up at the wrong path and the
        // later signed playback URL 404s. Encode each segment separately and
        // join with a literal `/` (same fix as the playback route).
        const objectPath = `videos/${parsed.data}.${ext}`;
        const objectSegments = objectPath.split("/").map(encodeURIComponent).join("/");

        // Forward the raw body to Cloud Storage with upsert so a retry of the
        // same id replaces cleanly. The body is a ReadableStream — pipe it
        // through without buffering the whole file into memory.
        const uploadUrl = `${url}/storage/v1/object/${encodeBucket(bucket)}/${objectSegments}`;

        try {
          const uploadRes = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              "Content-Type": contentType,
              "x-upsert": "true",
            },
            body: request.body,
            // @ts-expect-error - duplex is required for streaming request bodies
            // in fetch but not in the TS DOM lib types yet.
            duplex: "half",
          });

          if (!uploadRes.ok) {
            const text = await uploadRes.text().catch(() => "");
            console.warn("[upload-proxy] object POST failed:", uploadRes.status, text);
            // Surface the real storage error (status + sanitized body) so the
            // client can report an actionable message instead of a generic
            // "Cloud not reachable". Never echo the key or auth headers.
            return new Response(
              JSON.stringify({
                ok: false,
                error: `storage ${uploadRes.status}`,
                message: text.slice(0, 300) || uploadRes.statusText,
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
        } catch (e) {
          console.warn("[upload-proxy] object POST threw:", e instanceof Error ? e.message : e);
          return new Response(
            JSON.stringify({ ok: false, error: "transport", message: "Upload transport error" }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ ok: true, storagePath: objectPath, ext }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});

// Re-exported for any server-side callers that need the meta writer directly.
export async function persistMeta(record: VideoRecord): Promise<boolean> {
  try {
    await saveVideoMetaServer(record);
    return true;
  } catch {
    return false;
  }
}

export async function readMeta(id: string): Promise<VideoRecord | null> {
  try {
    return await getVideoMetaServer(id);
  } catch {
    return null;
  }
}
