/**
 * CSV for spreadsheets. A cell that starts with = + - @ (or a tab or return) would
 * be run as a formula when the file is opened, and several columns here hold text
 * that came from outside parties, so such a cell is prefixed to make it inert.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(head: string[], rows: unknown[][]): string {
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
