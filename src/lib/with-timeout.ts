/**
 * Client-side helpers: a withTimeout wrapper for RPC promises, and a
 * safeCall that swallows transport errors and returns a fallback so a
 * stalled backend never leaves the UI spinning.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = 12000,
  message = "Request timed out",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function safeCall<T>(promise: Promise<T>, fallback: T, ms = 12000): Promise<T> {
  try {
    return await withTimeout(promise, ms);
  } catch {
    return fallback;
  }
}
