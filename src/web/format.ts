export function fmtUsd(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: abs > 0 && abs < 1 ? 4 : 2,
  }).format(n);
}

export function fmtNum(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat("en-US").format(n) : "—";
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

/** RFC 4180-ish CSV serialisation: quotes a field only if it needs it. */
export function toCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const field = (v: string | number | boolean | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(field).join(",")];
  for (const row of rows) lines.push(row.map(field).join(","));
  return lines.join("\r\n");
}

/**
 * Triggers a browser download of `csv` as `filename`. A UTF-8 BOM is
 * prepended so Excel (the tool most researchers will actually open this in)
 * doesn't mangle non-ASCII characters.
 */
export function downloadCsv(filename: string, csv: string): void {
  const BOM = "﻿";
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
