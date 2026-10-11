const connections = new Map<string, Set<() => void>>();

export function registerSessionTokenConnection(tokenId: string, close: () => void): () => void {
  let callbacks = connections.get(tokenId);
  if (!callbacks) {
    callbacks = new Set();
    connections.set(tokenId, callbacks);
  }
  callbacks.add(close);
  return () => {
    callbacks.delete(close);
    if (callbacks.size === 0) connections.delete(tokenId);
  };
}

export function closeSessionTokenConnections(tokenIds: string[]): void {
  for (const tokenId of tokenIds) {
    for (const close of connections.get(tokenId) ?? []) close();
  }
}
