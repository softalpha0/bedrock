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
  tab: "assets" as "assets" | "issuers" | "discover",
  loading: true,
  error: "",
  assets: [] as Asset[],
  totalAssets: 0,
  issuers: [] as Json[],
  q: "",
  type: "all",
  sort: "mcap" as "mcap" | "vol" | "price" | "name",
  discover: {
    loaded: false,
    loading: false,
    error: "",
    // CoinMarketCap assigns rwa_id sequentially as it onboards assets, so the
    // highest ids are its most recent RWA-universe additions. Split by
    // has_tokens: true = a token already backs it (newly launched); false =
    // tracked as a candidate but not yet tokenised (upcoming).
    launched: [] as Asset[],
    upcoming: [] as Asset[],
  },
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

const DISCOVER_TAIL = 250;
const DISCOVER_SHOW = 15;

async function loadNewAndUpcoming(): Promise<void> {
  state.discover.loading = true;
  state.discover.error = "";
  render();
  try {
    // /v5/real-world-assets/map lists assets in ascending rwa_id order, so its
    // last page is CoinMarketCap's most recently onboarded RWAs.
    const first = await api("/api/map?start=1&limit=1");
    const total = num(first?.data?.total_size) || DISCOVER_TAIL;
    const start = Math.max(1, total - DISCOVER_TAIL + 1);
    const body = await api(`/api/map?start=${start}&limit=${DISCOVER_TAIL}`);
    const tail = assetsFrom(body).map(toAsset).reverse(); // newest first

    state.discover.launched = tail.filter((a) => a.hasTokens).slice(0, DISCOVER_SHOW);
    state.discover.upcoming = tail.filter((a) => !a.hasTokens).slice(0, DISCOVER_SHOW);
    state.discover.loaded = true;
    state.discover.error = "";
  } catch (e) {
    state.discover.error = (e as Error).message;
  }
  state.discover.loading = false;
  render();
}

// --- asset detail ("research") view ------------------------------------------
// CoinMarketCap has no public web page for an RWA *asset* (/rwa/* 404s), but each
// individual token that backs it is a listed cryptocurrency with its own CMC
// profile. The detail view is built from /info (company facts + a Q&A
// description), /quotes/latest (live quote + backing tokens), and a
// /v2/cryptocurrency/info lookup that turns each token's crypto_id into its CMC
// page slug.

const detail = {
  open: false,
  loading: false,
  error: "",
  asset: null as Asset | null,
  info: null as Json,
  quote: null as Json,
  slugs: {} as Record<string, string>, // crypto_id -> coinmarketcap.com slug
  showRaw: false,
};

const cmcUrl = (slug: string) => `https://coinmarketcap.com/currencies/${slug}/`;

async function openDetail(asset: Asset): Promise<void> {
  detail.open = true;
  detail.loading = true;
  detail.error = "";
  detail.asset = asset;
  detail.info = null;
  detail.quote = null;
  detail.slugs = {};
  detail.showRaw = false;
  render();

  const id = encodeURIComponent(String(asset.id));
  const [infoR, quoteR] = await Promise.allSettled([
    api(`/api/info?rwa_id=${id}`),
    api(`/api/quotes?rwa_id=${id}&convert=USD`),
  ]);
  const first = (r: PromiseSettledResult<Json>) =>
    r.status === "fulfilled" ? (r.value?.data?.rwa_assets?.[0] ?? null) : null;
  detail.info = first(infoR);
  detail.quote = first(quoteR);
  if (!detail.info && !detail.quote) {
    detail.error =
      infoR.status === "rejected"
        ? (infoR.reason as Error).message
        : "No detail available for this asset.";
  }

  // Resolve each backing token's CoinMarketCap profile page (best-effort).
  const tokens: Json[] = Array.isArray(detail.quote?.tokens) ? detail.quote.tokens : [];
  const ids = [
    ...new Set(
      tokens
        .map((t) => t?.crypto_id)
        .filter((x): x is number => typeof x === "number" && x > 0),
    ),
  ];
  if (ids.length) {
    try {
      const body = await api(`/api/crypto-info?id=${ids.join(",")}`);
      const data: Json = body?.data ?? {};
      for (const key of Object.keys(data)) {
        const c = data[key];
        if (c?.slug) detail.slugs[String(c.id ?? key)] = String(c.slug);
      }
    } catch {
      /* leave links off if the lookup fails */
    }
  }

  detail.loading = false;
  render();
}

function closeDetail(): void {
  detail.open = false;
  render();
}

// Tiny Markdown renderer for the `about.description` field (### headings,
// paragraphs, **bold**). Escapes first, so it is safe on untrusted text.
function mdLite(src: string): string {
  const e = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
  const inline = (s: string) => e(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h4>${inline(h[1] as string)}</h4>`);
    } else {
      para.push(line);
    }
  }
  flush();
  return out.join("");
}

function detailOverlay(): string {
  if (!detail.open || !detail.asset) return "";
  const a = detail.asset;
  const info: Json = detail.info ?? {};
  const q: Json = detail.quote ?? {};
  const tokens: Json[] = Array.isArray(q.tokens)
    ? q.tokens
    : Array.isArray(info.tokens)
      ? info.tokens
      : [];
  const cik = String(info.cik ?? "").replace(/\D/g, "");
  const edgar = cik
    ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`
    : "";
  const facts: Array<[string, string]> = (
    [
      ["Type", a.type],
      ["Rank", a.rank ? `#${a.rank}` : ""],
      ["Industry", info.industry ?? ""],
      ["Primary exchange", info.primary_exchange ?? ""],
      ["Founded", info.founded ? String(info.founded).slice(0, 10) : ""],
      ["Employees", info.employees ? fmtNum(info.employees) : ""],
      ["SEC CIK", cik],
    ] as Array<[string, string]>
  ).filter(([, v]) => v);
  const desc = String(info?.about?.description ?? info?.description ?? "");

  // Most valuable backing token that has a CoinMarketCap page — used as the
  // asset's headline "view on CoinMarketCap" link.
  const primary = [...tokens]
    .filter((t) => detail.slugs[String(t?.crypto_id)])
    .sort((x, y) => num(y?.market_cap) - num(x?.market_cap))[0];
  const primaryCmc = primary ? cmcUrl(detail.slugs[String(primary.crypto_id)] as string) : "";

  return `
  <div class="ov" data-ovbackdrop>
    <div class="ov-card" role="dialog" aria-modal="true" aria-label="${esc(a.name)}">
      <button class="ov-x" data-ovclose aria-label="Close">×</button>
      <h2>${esc(a.name)} <span class="sym">${esc(a.symbol)}</span></h2>
      ${detail.loading ? `<p class="muted">Loading…</p>` : ""}
      ${detail.error ? `<div class="error">${esc(detail.error)}</div>` : ""}

      <div class="ov-quote">
        <div><span>Tokenised price</span><strong>${fmtUsd(q.average_tokenized_price ?? a.price)}</strong></div>
        <div><span>Tokenised market cap</span><strong>${fmtUsd(q.tokenized_market_cap ?? a.mcap)}</strong></div>
        <div><span>24h tokenised volume</span><strong>${fmtUsd(q.tokenized_volume_24h ?? a.vol)}</strong></div>
      </div>

      ${
        facts.length
          ? `<table class="ov-facts">${facts
              .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
              .join("")}</table>`
          : ""
      }

      ${
        primaryCmc || info.website || edgar
          ? `<div class="ov-links">
               ${primaryCmc ? `<a href="${primaryCmc}" target="_blank" rel="noopener noreferrer">CoinMarketCap: ${esc(primary?.symbol ?? "token")} ↗</a>` : ""}
               ${info.website ? `<a href="${esc(info.website)}" target="_blank" rel="noopener noreferrer">Official site ↗</a>` : ""}
               ${edgar ? `<a href="${edgar}" target="_blank" rel="noopener noreferrer">SEC EDGAR filings ↗</a>` : ""}
             </div>`
          : ""
      }

      ${
        tokens.length
          ? `<h3>Backing tokens · ${tokens.length}</h3>
             <table class="grid ov-tokens">
               <thead><tr><th>Token</th><th>Issuer</th><th class="r">Price</th><th class="r">Market cap</th></tr></thead>
               <tbody>${tokens
                 .map((tk) => {
                   const slug = detail.slugs[String(tk?.crypto_id)];
                   const sym = esc(tk.symbol ?? "");
                   const symCell = slug
                     ? `<a href="${cmcUrl(slug)}" target="_blank" rel="noopener noreferrer">${sym}</a>`
                     : sym;
                   return `<tr>
                     <td><strong>${symCell}</strong> <span class="sym">${esc(tk.name ?? "")}</span></td>
                     <td>${esc(tk.issuer_name ?? tk.issuer_id ?? "—")}</td>
                     <td class="r">${fmtUsd(tk.price)}</td>
                     <td class="r">${fmtUsd(tk.market_cap)}</td>
                   </tr>`;
                 })
                 .join("")}</tbody>
             </table>`
          : ""
      }

      ${desc ? `<h3>About</h3><div class="ov-about">${mdLite(desc)}</div>` : ""}

      <button class="ov-raw" data-ovraw>${detail.showRaw ? "Hide" : "Show"} raw API records</button>
      ${
        detail.showRaw
          ? `<pre>${esc(
              JSON.stringify({ "assets/list": a.raw, info: detail.info, "quotes/latest": detail.quote }, null, 2),
            )}</pre>`
          : ""
      }
    </div>
  </div>`;
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
  const isLoading = state.tab === "discover" ? state.discover.loading : state.loading;
  const activeError = state.tab === "discover" ? state.discover.error : state.error;
  const body = isLoading
    ? `<div class="loading">Loading…</div>`
    : state.tab === "assets"
      ? assetsView(t)
      : state.tab === "issuers"
        ? issuersView()
        : discoverView();

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <h1>Bedrock</h1>
        <p class="tag">Tokenised stocks, treasuries &amp; commodities · CoinMarketCap RWA API</p>
      </div>
      <nav class="tabs">
        <button data-tab="assets" class="${state.tab === "assets" ? "on" : ""}">Assets</button>
        <button data-tab="issuers" class="${state.tab === "issuers" ? "on" : ""}">Issuers</button>
        <button data-tab="discover" class="${state.tab === "discover" ? "on" : ""}">New &amp; Upcoming</button>
      </nav>
    </header>
    <div class="mock-banner">
      Serving bundled sample data — add <code>CMC_API_KEY</code> to <code>.env</code> and restart for live data.
    </div>
    ${activeError ? `<div class="error">${esc(activeError)}</div>` : ""}
    ${body}
    <footer>
      Source: CoinMarketCap Pro API · <code>/v5/real-world-assets/</code>
      <code>assets/list</code>, <code>issuers/list</code>, <code>quotes/latest</code>, <code>info</code>,
      <code>map</code> · <code>/v2/cryptocurrency/info</code>
    </footer>
    ${detailOverlay()}
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
      } · click a row for detail</span>
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
        <tr class="row" data-i="${i}" title="Open ${esc(r.name)} detail">
          <td><strong>${esc(r.name)}</strong> <span class="sym">${esc(r.symbol)}</span></td>
          <td><span class="pill">${esc(r.type)}</span></td>
          <td class="r">${fmtUsd(r.price)}</td>
          <td class="r">${fmtUsd(r.mcap)}</td>
          <td class="r">${fmtUsd(r.vol)}</td>
          <td class="r">${r.hasTokens ? "✓" : "—"}</td>
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

function discoverTable(bucket: "l" | "u", rows: Asset[], emptyMsg: string): string {
  if (!rows.length) return `<p class="muted">${esc(emptyMsg)}</p>`;
  return `
    <table class="grid">
      <thead><tr><th>Asset</th><th>Type</th><th class="r">Rank</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r, i) => `
        <tr class="row" data-i="${i}" data-bucket="${bucket}" title="Open ${esc(r.name)} detail">
          <td><strong>${esc(r.name)}</strong> <span class="sym">${esc(r.symbol)}</span></td>
          <td><span class="pill">${esc(r.type)}</span></td>
          <td class="r">${r.rank ? `#${fmtNum(r.rank)}` : "—"}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function discoverView(): string {
  const d = state.discover;
  return `
    <section class="panel">
      <h2>Newly launched</h2>
      <p class="muted">
        CoinMarketCap's most recent RWA-universe additions that already have a
        live token backing them — by <code>rwa_id</code>, its onboarding order.
      </p>
      ${discoverTable("l", d.launched, "Nothing newly tokenised in the latest batch.")}
    </section>
    <section class="panel">
      <h2>Upcoming</h2>
      <p class="muted">
        Assets CoinMarketCap now tracks as RWA candidates — recognised, but with
        <strong>no token yet</strong> (<code>has_tokens: false</code>). The API has
        no separate "upcoming" endpoint; this is the closest honest signal it exposes.
      </p>
      ${discoverTable("u", d.upcoming, "Nothing pending in the latest batch.")}
    </section>
  `;
}

function bind(): void {
  app.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as typeof state.tab;
      if (state.tab === "issuers" && state.issuers.length === 0) void loadIssuers();
      else if (state.tab === "discover" && !state.discover.loaded) void loadNewAndUpcoming();
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
      const i = Number(tr.dataset.i);
      if (state.tab === "assets") {
        const row = visibleAssets().slice(0, MAX_TABLE_ROWS)[i];
        if (row) void openDetail(row);
      } else if (state.tab === "discover") {
        const list = tr.dataset.bucket === "l" ? state.discover.launched : state.discover.upcoming;
        const row = list[i];
        if (row) void openDetail(row);
      } else {
        const d = app.querySelector<HTMLTableRowElement>(`tr.detail[data-d="${i}"]`);
        if (d) d.hidden = !d.hidden;
      }
    });
  });

  const backdrop = app.querySelector<HTMLElement>("[data-ovbackdrop]");
  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) closeDetail();
  });
  app.querySelector<HTMLButtonElement>("[data-ovclose]")?.addEventListener("click", closeDetail);
  app.querySelector<HTMLButtonElement>("[data-ovraw]")?.addEventListener("click", () => {
    detail.showRaw = !detail.showRaw;
    render();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detail.open) closeDetail();
});

void loadAssets();
