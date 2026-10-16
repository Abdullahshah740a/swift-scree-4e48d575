// Ambient declaration for the runtime CDN import of @huggingface/transformers
// loaded via /* @vite-ignore */ so the ~150MB model + onnxruntime aren't bundled.
declare module "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.4" {
  export const env: {
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
  };
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<(input: string, options?: Record<string, unknown>) => Promise<unknown>>;
}
