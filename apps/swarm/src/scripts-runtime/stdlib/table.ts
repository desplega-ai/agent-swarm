export function table(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";

  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const renderedRows = rows.map((row) => headers.map((header) => String(row[header] ?? "")));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...renderedRows.map((row) => row[index]?.length ?? 0)),
  );

  const render = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  return [
    render(headers),
    render(widths.map((width) => "-".repeat(width))),
    ...renderedRows.map(render),
  ].join("\n");
}
