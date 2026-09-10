import { esc } from "./format.js";

export type BarRow = { label: string; value: number };

/** Minimal dependency-free horizontal bar chart, returned as an SVG string. */
export function barChart(rows: BarRow[], fmt: (n: number) => string): string {
  const data = rows.filter((r) => Number.isFinite(r.value) && r.value > 0);
  if (!data.length) return `<p class="muted">No numeric data to chart.</p>`;

  const max = Math.max(...data.map((r) => r.value));
  const rowH = 28;
  const width = 680;
  const labelW = 160;
  const valueW = 96;
  const barW = width - labelW - valueW;
  const height = data.length * rowH + 8;

  const bars = data
    .map((r, i) => {
      const y = i * rowH + 4;
      const w = Math.max(2, (r.value / max) * barW);
      return `
    <text x="${labelW - 10}" y="${y + 17}" text-anchor="end" class="c-label">${esc(r.label)}</text>
    <rect x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="${rowH - 14}" rx="3" class="c-bar" />
    <text x="${(labelW + w + 8).toFixed(1)}" y="${y + 17}" class="c-value">${esc(fmt(r.value))}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Bar chart">${bars}
</svg>`;
}
