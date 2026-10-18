/** Case-insensitive substring match on table name; blank query keeps every table. */
export function filterTables(tables: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tables;
  return tables.filter((name) => name.toLowerCase().includes(needle));
}
