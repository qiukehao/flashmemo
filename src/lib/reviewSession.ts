/** Deduplicates a session load when React replays an effect or native code
 * emits the same popup-open signal more than once. */
export function createSessionLoader<T>(read: (sessionId: number) => Promise<T>) {
  const pending = new Map<number, Promise<T>>();
  return (sessionId: number): Promise<T> => {
    const existing = pending.get(sessionId);
    if (existing) return existing;
    const request = read(sessionId).finally(() => {
      // Keep the completed promise so duplicate delayed native signals remain
      // harmless, while a different session always gets a fresh request.
    });
    pending.set(sessionId, request);
    return request;
  };
}
