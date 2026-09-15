export function isSafeBundlePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 256 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
