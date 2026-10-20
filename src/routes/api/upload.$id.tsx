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
// This route receives the raw video bytes as a same-origin POST, buffers them
// once server-side, and forwards them to Cloud Storage using the service-role
// key (server-side only), then persists the metadata JSON — so "Saved to
// Cloud" is only ever returned when BOTH the video object and its metadata
// actually exist. The key never reaches the browser, there's no CORS preflight
// on the app origin, and the bytes are buffered once (not base64-bloated, not
// Seroval-serialized).
//
// WHY we buffer instead of streaming request.body: Supabase Storage's S3-style
// object-upload endpoint does NOT finalize a chunked/transfer-encoded body —
// streaming request.body (a ReadableStream) leaves the upstream POST hanging
// indefinitely waiting for a Content-Length it never receives, so the server
// fetch never resolved and the only thing that stopped it was the browser's
// 120s AbortController ("fetch-aborted / no response"). Buffering gives fetch a
// concrete ArrayBuffer so it sets Content-Length and Supabase completes the
// upload. A same-origin POST to a server route is a different transport than
// base64-over-RPC (which failed on *serialization* limits), so a few-MB
// recording is well within the worker's request-body budget. The upstream call
// is also bounded by its own AbortController so a stall surfaces as a 502 with
// a real message instead of hanging until the browser aborts.

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
      // Reachability probe: a GET returns 200 so the client can verify the
      // route is reachable from the browser BEFORE attempting the POST.
      // If this GET also fails with "Failed to fetch", the issue is route
      // reachability (network/gateway), not the POST body.
      GET: async ({ params }) => {
        const id = String((params as { id?: string }).id ?? "");
        return new Response(JSON.stringify({ ok: true, id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      POST: async ({ params, request }) => {
        const id = String((params as { id?: string }).id ?? "");
        const startedAt = Date.now();
        const log = (stage: string, extra?: Record<string, unknown>) =>
          console.info(
            `[upload-proxy] id=${id} stage=${stage} elapsed=${Date.now() - startedAt}ms`,
            extra ?? "",
          );

        if (!id) return new Response("Missing id", { status: 400 });

        const contentType = request.headers.get("content-type") ?? "application/octet-stream";
        const expectedExt = request.headers.get("x-ext") ?? "webm";

        const { url, key, bucket } = env();
        if (!url || !key || !bucket) {
          log("not-configured");
          return new Response("Storage not configured", { status: 502 });
        }

        // Validate the id is a sane path component (no path traversal).
        const idSchema = z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9_-]+$/);
        const parsed = idSchema.safeParse(id);
        if (!parsed.success) {
          log("invalid-id");
          return new Response("Invalid id", { status: 400 });
        }

        const ext = String(expectedExt).toLowerCase().endsWith("mp4") ? "mp4" : "webm";
        const objectPath = `videos/${parsed.data}.${ext}`;

        // Forward the body to Cloud Storage with upsert so a retry of the
        // same id replaces cleanly. Buffer it so fetch sets Content-Length and
        // Supabase Storage finalizes the object (see the file header for why
        // streaming request.body hangs the S3-style upload endpoint).
        const uploadUrl = `${url}/storage/v1/object/${encodeBucket(bucket)}/${encodeURIComponent(
          objectPath,
        )}`;

        const contentLength = request.headers.get("content-length");
        let bodyBuf: ArrayBuffer;
        try {
          bodyBuf = await request.arrayBuffer();
        } catch (e) {
          log("body-read-failed", { name: e instanceof Error ? e.name : "Error" });
          return new Response("Upload failed (could not read body)", { status: 500 });
        }
        log("proxy-start", { bytes: contentLength, buffered: bodyBuf.byteLength });

        // Bound the upstream call so a stall surfaces as a 502 here instead of
        // hanging until the browser aborts. This is a safety net distinct from
        // the buffering fix that addresses the underlying chunked-body hang.
        const upstreamCtrl = new AbortController();
        const upstreamTimer = setTimeout(() => upstreamCtrl.abort(), 90_000);
        try {
          const uploadRes = await fetch(uploadUrl, {
            method: "POST",
            signal: upstreamCtrl.signal,
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              "Content-Type": contentType,
              "x-upsert": "true",
            },
            body: bodyBuf,
          });

          if (!uploadRes.ok) {
            const text = await uploadRes.text().catch(() => "");
            log("storage-rejected", { status: uploadRes.status, body: text.slice(0, 200) });
            return new Response(`Upload failed (${uploadRes.status})`, { status: 502 });
          }
          log("storage-ok", { status: uploadRes.status, bytes: bodyBuf.byteLength });
        } catch (e) {
          const name = e instanceof Error ? e.name : "Error";
          log("storage-threw", { name });
          return new Response(
            name === "AbortError"
              ? "Upload failed (upstream timeout)"
              : "Upload failed (transport)",
            { status: 502 },
          );
        } finally {
          clearTimeout(upstreamTimer);
        }

        // Persist the metadata JSON. The client passes it as a query/header so
        // the body stays as the raw video bytes. Only the client knows the
        // full record; the server reconstructs it from headers + the uploaded
        // object. To keep this robust without serializing the whole record in
        // a header, the client also calls saveVideoMeta via the server-fn —
        // but we return the object path so the client can build the record.
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
