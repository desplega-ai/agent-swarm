declare module "*.md" {
  const content: string;
  export default content;
}

// Bun imports a .wasm file as its path (embedded in a compiled binary).
declare module "*.wasm" {
  const path: string;
  export default path;
}
