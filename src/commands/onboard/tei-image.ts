/** TEI image for the bundled embeddings server on arm64 hosts. */
export const TEI_ARM64_IMAGE = "ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9.4";

/**
 * TEI publishes one tag per CPU architecture, so Compose `platform:` cannot
 * pick it. `install.sh` runs onboard on the Docker host, so the host arch is
 * the engine arch. Returns `null` for amd64 and anything else: the compose
 * default (`cpu-1.9.4`, amd64) applies.
 */
export function teiImageForArch(arch: string): string | null {
  return arch === "arm64" || arch === "aarch64" ? TEI_ARM64_IMAGE : null;
}
