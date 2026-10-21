/** Rebuild MediaRecorder's live WebM header and cues without re-encoding frames. */
export async function makeSeekableWebm(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  if (!blob.type.toLowerCase().includes("webm")) return blob;

  // Use the self-contained browser build: the Node entry relies on global Buffer.
  const { default: ebml } = await import("ts-ebml/dist/EBML.js");
  const { Decoder, Reader, tools } = ebml;
  const decoder = new Decoder();
  const reader = new Reader();
  reader.logging = false;
  reader.use_segment_info = false;
  reader.drop_default_duration = false;

  // Decode incrementally: do not allocate a second full copy of a long recording.
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    signal?.throwIfAborted();
    const bytes = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    for (const element of decoder.decode(bytes)) reader.read(element);
  }
  reader.stop();
  signal?.throwIfAborted();
  if (
    !Number.isFinite(reader.duration) ||
    reader.duration <= 0 ||
    reader.metadataSize <= 0 ||
    reader.metadataSize >= blob.size ||
    reader.cues.length === 0
  ) {
    throw new Error("Could not determine the recording's duration and seek index.");
  }

  const metadata = tools.makeMetadataSeekable(reader.metadatas, reader.duration, reader.cues);
  return new Blob([metadata, blob.slice(reader.metadataSize)], { type: blob.type });
}
