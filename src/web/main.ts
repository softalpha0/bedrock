import "./style.css";
import { fmtUsd, fmtNum, esc } from "./format.js";
import { barChart } from "./charts.js";

type Json = any;

const app = document.querySelector<HTMLDivElement>("#app")!;

async function api(path: string): Promise<Json> {
  const res = await fetch(path);
  const mode = res.headers.get("x-bedrock-mode");
  if (mode) document.body.dataset.mode = mode;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Request failed: ${res.status}`);
  return body;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// The RWA payloads are new and still settling, so read defensively and let the
// raw-JSON drawer be the source of truth for anything not surfaced here.
function assetsFrom(body: Json): Json[] {
  const d = body?.data ?? body ?? {};
  return d.rwa_assets ?? d.assets ?? d.list ?? (Array.isArray(d) ? d : []);
}

function issuersFrom(body: Json): Json[] {
  const d = body?.data ?? body ?? {};
  return d.issuers ?? d.list ?? (Array.isArray(d) ? d : []);
}

type Asset = {
  id: string | number;
  name: string;
  symbol: string;
  type: string;
  rank: number;
  price: number;
  mcap: number;
  vol: number;
  hasTokens: boolean;
  raw: Json;
};

// Live shape (assets/list): top-level tokenized_* fields plus a `quotes` array
// keyed by fiat symbol; `has_tokens` boolean, no per-asset token count.
function toAsset(a: Json): Asset {
  const quotes: Json[] = Array.isArray(a?.quotes) ? a.quotes : [];
  const q =
    quotes.find((x) => String(x?.symbol ?? "").toUpperCase() === "USD") ??
    quotes[0] ??
    a?.quote?.USD ??
    a?.quote?.usd ??
    {};
  return {
    id: a?.rwa_id ?? a?.id ?? a?.slug ?? "",
    name: a?.name ?? a?.asset_name ?? "Unknown",
    symbol: a?.symbol ?? a?.ticker ?? "",
    type: String(a?.asset_type ?? a?.type ?? a?.category ?? "—"),
    rank: num(a?.rwa_rank ?? a?.rank),
    price: num(a?.average_tokenized_price ?? q.average_tokenized_price ?? a?.price ?? q.price),
    mcap: num(a?.tokenized_market_cap ?? q.tokenized_market_cap ?? a?.market_cap ?? q.market_cap),
    vol: num(a?.tokenized_volume_24h ?? q.tokenized_volume_24h ?? a?.volume_24h ?? q.volume_24h),
    hasTokens: a?.has_tokens === true || num(a?.num_tokens) > 0,
    raw: a,
  };
}

// assets/list is ~8k rows deep and power-law distributed, so we pull the top
// slice by rank (a few pages) for the table/chart/aggregates and report the true
// universe size from the API's `total_size`.
const PAGE = 250;
const MAX_LOADED = 1000;
const MAX_TABLE_ROWS = 250;

const state = {
  tab: "assets" as "assets" | "issuers",
  loading: true,
  error: "",
  assets: [] as Asset[],
  totalAssets: 0,
  issuers: [] as Json[],
  q: "",
  type: "all",
  sort: "mcap" as "mcap" | "vol" | "price" | "name",
};

async function loadAssets(): Promise<void> {
  state.loading = true;
  render();
  try {
    const loaded: Asset[] = [];
    for (let start = 1; start <= MAX_LOADED; start += PAGE) {
      const body = await api(`/api/assets?start=${start}&limit=${PAGE}&convert=USD`);
      const d = body?.data ?? {};
      state.totalAssets = num(d.total_size) || state.totalAssets;
      const page = assetsFrom(body).map(toAsset);
      loaded.push(...page);
      if (page.length < PAGE || d.has_more === false) break;
    }
    state.assets = loaded;
    if (!state.totalAssets) state.totalAssets = loaded.length;
    state.error = "";
  } catch (e) {
    state.error = (e as Error).message;
  }
  state.loading = false;
  render();
}

async function loadIssuers(): Promise<void> {
  state.loading = true;
  render();
  try {
    const body = await api("/api/issuers?start=1&limit=250");
    state.issuers = issuersFrom(body);
    state.error = "";
  } catch (e) {
    state.error = (e as Error).message;
  }
  state.loading = false;
  render();
}

function visibleAssets(): Asset[] {
  let rows = state.assets;
  if (state.type !== "all") rows = rows.filter((r) => r.type === state.type);
  const q = state.q.trim().toLowerCase();
  if (q) rows = rows.filter((r) => `${r.name} ${r.symbol}`.toLowerCase().includes(q));

  return [...rows].sort((a, b) => {
    if (state.sort === "name") return a.name.localeCompare(b.name);
    const av = a[state.sort];
    const bv = b[state.sort];
    return (Number.isFinite(bv) ? bv : -Infinity) - (Number.isFinite(av) ? av : -Infinity);
  });
}

function totals() {
  const sum = (key: "mcap" | "vol") =>
    state.assets.reduce((s, r) => s + (Number.isFinite(r[key]) ? r[key] : 0), 0);
  return {
    universe: state.totalAssets,
    loaded: state.assets.length,
    mcap: sum("mcap"),
    vol: sum("vol"),
  };
}

function render(): void {
  const t = totals();
  const body = state.loading
    ? `<div class="loading">Loading…</div>`
    : state.tab === "assets"
      ? assetsView(t)
      : issuersView();

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <h1>Bedrock</h1>
        <p class="tag">Tokenised stocks, treasuries &amp; commodities · CoinMarketCap RWA API</p>
      </div>
      <nav class="tabs">
        <button data-tab="assets" class="${state.tab === "assets" ? "on" : ""}">Assets</button>
        <button data-tab="issuers" class="${state.tab === "issuers" ? "on" : ""}">Issuers</button>
      </nav>
    </header>
    <div class="mock-banner">
      Serving bundled sample data — add <code>CMC_API_KEY</code> to <code>.env</code> and restart for live data.
    </div>
    ${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
    ${body}
    <footer>
      Source: CoinMarketCap Pro API ·
      <code>/v5/real-world-assets/assets/list</code>,
      <code>/issuers/list</code>,
      <code>/issuers</code>,
      <code>/quotes/latest</code>,
      <code>/market-pairs/list</code>
    </footer>
  `;
  bind();
}

function assetsView(t: ReturnType<typeof totals>): string {
  const all = visibleAssets();
  const rows = all.slice(0, MAX_TABLE_ROWS);
  const types = ["all", ...Array.from(new Set(state.assets.map((r) => r.type))).sort()];
  const top = all.slice(0, 12).map((r) => ({ label: r.symbol || r.name, value: r.mcap }));
  const partial = t.loaded < t.universe;

  return `
    <section class="cards">
      <div class="card"><span>Assets tracked</span><strong>${fmtNum(t.universe)}</strong></div>
      <div class="card"><span>Tokenised market cap${partial ? " · top " + fmtNum(t.loaded) : ""}</span><strong>${fmtUsd(t.mcap)}</strong></div>
      <div class="card"><span>24h tokenised volume${partial ? " · top " + fmtNum(t.loaded) : ""}</span><strong>${fmtUsd(t.vol)}</strong></div>
    </section>
    ${
      partial
        ? `<p class="muted cards-note">Table, chart and aggregates cover the top ${fmtNum(
            t.loaded,
          )} assets by market cap; the API tracks ${fmtNum(t.universe)} in total.</p>`
        : ""
    }

    <section class="panel">
      <h2>Top assets by tokenised market cap</h2>
      ${barChart(top, fmtUsd)}
    </section>

    <section class="controls">
      <input id="q" type="search" placeholder="Search name or symbol" value="${esc(state.q)}" />
      <select id="type" aria-label="Filter by asset type">
        ${types
          .map(
            (ty) =>
              `<option value="${esc(ty)}" ${ty === state.type ? "selected" : ""}>${
                ty === "all" ? "All types" : esc(ty)
              }</option>`,
          )
          .join("")}
      </select>
      <select id="sort" aria-label="Sort assets">
        <option value="mcap" ${state.sort === "mcap" ? "selected" : ""}>Sort: market cap</option>
        <option value="vol" ${state.sort === "vol" ? "selected" : ""}>Sort: 24h volume</option>
        <option value="price" ${state.sort === "price" ? "selected" : ""}>Sort: price</option>
        <option value="name" ${state.sort === "name" ? "selected" : ""}>Sort: name</option>
      </select>
      <span class="count">${
        all.length > rows.length
          ? `${fmtNum(rows.length)} of ${fmtNum(all.length)} — refine to see more`
          : `${fmtNum(all.length)} shown`
      }</span>
    </section>

    <table class="grid">
      <thead>
        <tr>
          <th>Asset</th><th>Type</th>
          <th class="r">Tokenised price</th>
          <th class="r">Market cap</th>
          <th class="r">24h volume</th>
          <th class="r">Tokenised</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r, i) => `
        <tr class="row" data-i="${i}">
          <td><strong>${esc(r.name)}</strong> <span class="sym">${esc(r.symbol)}</span></td>
          <td><span class="pill">${esc(r.type)}</span></td>
          <td class="r">${fmtUsd(r.price)}</td>
          <td class="r">${fmtUsd(r.mcap)}</td>
          <td class="r">${fmtUsd(r.vol)}</td>
          <td class="r">${r.hasTokens ? "✓" : "—"}</td>
        </tr>
        <tr class="detail" data-d="${i}" hidden>
          <td colspan="6"><pre>${esc(JSON.stringify(r.raw, null, 2))}</pre></td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function issuersView(): string {
  const rows = [...state.issuers].sort((a, b) => num(b?.num_tokens) - num(a?.num_tokens));
  const totalTokens = rows.reduce((s, it) => s + (num(it?.num_tokens) || 0), 0);
  return `
    <section class="panel">
      <h2>Token issuers</h2>
      <p class="muted">
        ${fmtNum(rows.length)} issuers · ${fmtNum(totalTokens)} tokenised instruments ·
        <code>/v5/real-world-assets/issuers/list</code>
      </p>
    </section>
    <table class="grid">
      <thead>
        <tr><th>Issuer</th><th>Website</th><th class="r">Tokens issued</th></tr>
      </thead>
      <tbody>
        ${rows
          .map((it, i) => {
            const site = String(it?.website ?? "");
            const host = site ? site.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
            return `
        <tr class="row" data-i="${i}">
          <td><strong>${esc(it?.name ?? it?.issuer_name ?? "Unknown")}</strong></td>
          <td>${
            site
              ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a>`
              : "—"
          }</td>
          <td class="r">${fmtNum(it?.num_tokens ?? "—")}</td>
        </tr>
        <tr class="detail" data-d="${i}" hidden>
          <td colspan="3"><pre>${esc(JSON.stringify(it, null, 2))}</pre></td>
        </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function bind(): void {
  app.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as typeof state.tab;
      if (state.tab === "issuers" && state.issuers.length === 0) void loadIssuers();
      else render();
    });
  });

  const q = app.querySelector<HTMLInputElement>("#q");
  q?.addEventListener("input", () => {
    state.q = q.value;
    render();
    const next = app.querySelector<HTMLInputElement>("#q");
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });

  app.querySelector<HTMLSelectElement>("#type")?.addEventListener("change", (e) => {
    state.type = (e.target as HTMLSelectElement).value;
    render();
  });
  app.querySelector<HTMLSelectElement>("#sort")?.addEventListener("change", (e) => {
    state.sort = (e.target as HTMLSelectElement).value as typeof state.sort;
    render();
  });

  app.querySelectorAll<HTMLTableRowElement>("tr.row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const detail = app.querySelector<HTMLTableRowElement>(`tr.detail[data-d="${tr.dataset.i}"]`);
      if (detail) detail.hidden = !detail.hidden;
    });
  });
}

void loadAssets();
