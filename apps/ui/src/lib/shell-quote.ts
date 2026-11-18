/**
 * Quote a value for a POSIX shell command line. A value of only safe
 * characters stays as is. Any other value goes in single quotes, with each
 * `'` written as `'\''`, so the shell reads it as one literal word.
 */
export function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
