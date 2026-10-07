/**
 * Minimal source map v3 reader for the quickjs executor. It maps a
 * generated (line, column) back to the original source position so runtime
 * errors point at the user's TypeScript, not at the bundled JavaScript.
 *
 * Lines and columns are 1-based on input and output, to match stack frames.
 */

type Segment = { genColumn: number; source: number; line: number; column: number };

export type OriginalPosition = { source: string; line: number; column: number };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX = new Map([...BASE64].map((char, index) => [char, index]));

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64_INDEX.get(char);
    if (digit === undefined) throw new Error(`invalid source map VLQ character: ${char}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>>= 1;
    values.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return values;
}

export class SourceMapReader {
  private readonly sources: string[];
  private readonly lines: Segment[][];

  constructor(map: { sources: string[]; mappings: string }) {
    this.sources = map.sources;
    this.lines = [];
    let source = 0;
    let line = 0;
    let column = 0;
    for (const generatedLine of map.mappings.split(";")) {
      const segments: Segment[] = [];
      let genColumn = 0;
      for (const raw of generatedLine.split(",")) {
        if (!raw) continue;
        const fields = decodeVlq(raw);
        genColumn += fields[0] ?? 0;
        if (fields.length < 4) continue;
        source += fields[1] ?? 0;
        line += fields[2] ?? 0;
        column += fields[3] ?? 0;
        segments.push({ genColumn, source, line, column });
      }
      this.lines.push(segments);
    }
  }

  /** Look up the closest mapping at or before (line, column) on that line. */
  originalPositionFor(line: number, column: number): OriginalPosition | undefined {
    const segments = this.lines[line - 1];
    if (!segments || segments.length === 0) return undefined;
    let match: Segment | undefined;
    for (const segment of segments) {
      if (segment.genColumn > column - 1) break;
      match = segment;
    }
    match ??= segments[0];
    if (!match) return undefined;
    const source = this.sources[match.source];
    if (source === undefined) return undefined;
    return { source, line: match.line + 1, column: match.column + 1 };
  }
}
