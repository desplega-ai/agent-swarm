export function makeFakeAppServer(
  handleRequest: (
    method: string,
    params: unknown,
    emit: (method: string, params?: unknown) => void,
  ) => unknown | Promise<unknown>,
) {
  const listeners = new Set<(notification: { method: string; params?: unknown }) => void>();
  const closeListeners = new Set<(error: Error) => void>();
  const emit = (method: string, params?: unknown) => {
    for (const listener of listeners) listener({ method, params });
  };
  return {
    client: {
      request: <T>(method: string, params?: unknown) =>
        Promise.resolve(handleRequest(method, params, emit)) as Promise<T>,
      onNotification(listener: (notification: { method: string; params?: unknown }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(listener: (error: Error) => void) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      async close() {},
    },
    emit,
    fail(error: Error) {
      for (const listener of closeListeners) listener(error);
    },
  };
}
