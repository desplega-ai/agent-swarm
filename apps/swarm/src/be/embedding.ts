/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("Vectors must have the same length");
  if (a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Serialize a Float32Array embedding to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize a Buffer from SQLite BLOB storage back to a Float32Array.
 */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  const copy = new ArrayBuffer(buffer.length);
  const view = new Uint8Array(copy);
  view.set(buffer);
  return new Float32Array(copy);
}
