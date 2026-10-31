/** A short id for a label: the first 8 characters of a UUID or a hex id, a slug as is. */
export function shortId(id: string): string {
  return /^[0-9a-f-]{20,}$/i.test(id) ? id.slice(0, 8) : id;
}
