import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createFolder as createFolderServer,
  deleteFolder as deleteFolderServer,
  deleteVideo as deleteVideoServer,
  getStorageStatus as getStorageStatusServer,
  getTranscript as getTranscriptServer,
  getVideoMeta as getVideoMetaServer,
  listComments as listCommentsServer,
  listFolders as listFoldersServer,
  listReactions as listReactionsServer,
  listVideos as listVideosServer,
  moveVideo as moveVideoServer,
  saveComments as saveCommentsServer,
  saveFolders as saveFoldersServer,
  saveReactions as saveReactionsServer,
  saveTranscript as saveTranscriptServer,
  saveVideoMeta as saveVideoMetaServer,
  uploadVideo as uploadVideoServer,
} from "./storage.server";
import type { Comment, Folder, Reaction, Transcript, VideoRecord } from "./types";

export const getStorageStatus = createServerFn({ method: "GET" }).handler(async () =>
  getStorageStatusServer(),
);

export const listVideos = createServerFn({ method: "GET" }).handler(async () => listVideosServer());

export const getVideoMeta = createServerFn({ method: "GET" })
  .validator((data) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => getVideoMetaServer(data.id));

export const saveVideoMeta = createServerFn({ method: "POST" })
  .validator((data) => z.object({ record: z.any() }).parse(data))
  .handler(async ({ data }) => {
    await saveVideoMetaServer(data.record as VideoRecord);
    return { ok: true };
  });

export const uploadVideo = createServerFn({ method: "POST" })
  .validator((data) => z.object({ record: z.any(), base64: z.string() }).parse(data))
  .handler(async ({ data }) =>
    uploadVideoServer({
      record: data.record as VideoRecord,
      base64: data.base64,
    }),
  );

export const deleteVideo = createServerFn({ method: "POST" })
  .validator((data) => z.object({ id: z.string(), ext: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await deleteVideoServer(data.id, data.ext);
    return { ok: true };
  });

export const listFolders = createServerFn({ method: "GET" }).handler(async () =>
  listFoldersServer(),
);

export const saveFolders = createServerFn({ method: "POST" })
  .validator((data) => z.object({ folders: z.any() }).parse(data))
  .handler(async ({ data }) => {
    await saveFoldersServer(data.folders as Folder[]);
    return { ok: true };
  });

export const createFolder = createServerFn({ method: "POST" })
  .validator((data) => z.object({ id: z.string(), name: z.string() }).parse(data))
  .handler(async ({ data }) => createFolderServer(data.id, data.name));

export const deleteFolder = createServerFn({ method: "POST" })
  .validator((data) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => deleteFolderServer(data.id));

export const moveVideo = createServerFn({ method: "POST" })
  .validator((data) =>
    z.object({ videoId: z.string(), folderId: z.string().nullable() }).parse(data),
  )
  .handler(async ({ data }) => moveVideoServer(data.videoId, data.folderId));

export const listComments = createServerFn({ method: "GET" })
  .validator((data) => z.object({ videoId: z.string() }).parse(data))
  .handler(async ({ data }) => listCommentsServer(data.videoId));

export const saveComments = createServerFn({ method: "POST" })
  .validator((data) => z.object({ videoId: z.string(), comments: z.any() }).parse(data))
  .handler(async ({ data }) => {
    await saveCommentsServer(data.videoId, data.comments as Comment[]);
    return { ok: true };
  });

export const listReactions = createServerFn({ method: "GET" })
  .validator((data) => z.object({ videoId: z.string() }).parse(data))
  .handler(async ({ data }) => listReactionsServer(data.videoId));

export const saveReactions = createServerFn({ method: "POST" })
  .validator((data) => z.object({ videoId: z.string(), reactions: z.any() }).parse(data))
  .handler(async ({ data }) => {
    await saveReactionsServer(data.videoId, data.reactions as Reaction[]);
    return { ok: true };
  });

export const getTranscript = createServerFn({ method: "GET" })
  .validator((data) => z.object({ videoId: z.string() }).parse(data))
  .handler(async ({ data }) => getTranscriptServer(data.videoId));

export const saveTranscript = createServerFn({ method: "POST" })
  .validator((data) => z.object({ transcript: z.any() }).parse(data))
  .handler(async ({ data }) => {
    await saveTranscriptServer(data.transcript as Transcript);
    return { ok: true };
  });
