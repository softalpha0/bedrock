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

// A handful of assets/list records (~0.4% of the top 1000) carry rwa_id: null
// — Asset.id then falls back to their slug. Neither quotes/latest nor info
// accepts rwa_slug (both return 4001 Invalid parameter), so these have no
// working lookup at all; skip live calls for them rather than 400ing.
const hasWorkingId = (asset: Asset): boolean => /^\d+$/.test(String(asset.id));

/** Runs `fn` over `items` with at most `limit` in flight, collecting results in order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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

type SpreadRow = {
  asset: Asset;
  low: { symbol: string; issuer: string; price: number };
  high: { symbol: string; issuer: string; price: number };
  spreadPct: number;
  tokenCount: number;
};

type IssuerShare = { issuer: string; mcap: number };
type ChainShare = { chain: string; mcap: number };

// Browser storage can be unavailable (private mode, blocked site data) — every
// access is wrapped so the app degrades to a plain in-memory list instead of
// throwing.
const WATCHLIST_KEY = "bedrock:watchlist";
function loadWatchlist(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}
function saveWatchlist(ids: Set<string>): void {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable — watchlist just won't survive a reload */
  }
}

// Tab, search, filter and sort live in the URL so a specific view is linkable.
const urlParams = new URLSearchParams(location.search);
const TABS = ["assets", "spread", "issuers", "discover", "terminal"] as const;
const SORTS = ["mcap", "vol", "price", "name"] as const;
const initialTab = TABS.find((t) => t === urlParams.get("tab")) ?? "assets";
const initialSort = SORTS.find((s) => s === urlParams.get("sort")) ?? "mcap";

const state = {
  tab: initialTab as (typeof TABS)[number],
  loading: true,
  error: "",
  assets: [] as Asset[],
  totalAssets: 0,
  issuers: [] as Json[],
  q: urlParams.get("q") ?? "",
  type: urlParams.get("type") ?? "all",
  sort: initialSort as (typeof SORTS)[number],
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
  // Wrapper-spread + issuer-market-share + chain-share: all derived from the
  // same scan of quotes/latest across the top assets by market cap, so one
  // fetch feeds three views instead of three separate ones.
  scan: {
    loaded: false,
    loading: false,
    error: "",
    scannedCount: 0,
    excluded: 0,
    spread: [] as SpreadRow[],
    issuerShare: [] as IssuerShare[],
    chainShare: [] as ChainShare[],
  },
  usage: {
    loaded: false,
    error: "",
    creditsUsed: 0,
    creditsLimit: 0,
    resetIn: "",
    rateLimitPerMin: 0,
  },
  // Up to 4 asset ids selected on the Assets tab for side-by-side comparison.
  compare: new Set<string>(),
  compareOpen: false,
  // Starred asset ids, persisted locally per browser.
  watchlist: loadWatchlist(),
  watchlistOnly: false,
  // Terminal command box.
  terminalQuery: "",
  terminalError: "",
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

// --- market scan: wrapper spread + issuer market share -----------------------
// Neither view exists as a CMC endpoint — both are computed by calling
// quotes/latest (which returns each asset's individual backing tokens, priced
// separately) across a bounded slice of the market and aggregating client-side.
const SCAN_N = 80;
const SCAN_CONCURRENCY = 8;
// A ceiling on displayed spread. In practice, anything past this is virtually
// always a data-quality artifact rather than a real premium/discount — e.g.
// gold and silver wrappers denominated per gram vs. per troy ounce (a ~31x
// ratio) with no unit field in the API to tell them apart, or a stale quote on
// one venue. Filtering keeps the list to spreads worth taking seriously.
const SPREAD_MAX_PCT = 20;

async function loadMarketScan(): Promise<void> {
  if (state.scan.loaded || state.scan.loading) return;
  // Guards a startup race: on a direct link into Spread/Issuers/Terminal this
  // can fire before loadAssets() has populated anything to scan. Don't mark
  // the scan "loaded" over an empty candidate list — the caller (assetsReady
  // below, or a later tab click) will retry once assets are actually in.
  if (state.assets.length === 0) return;
  // A key-less mock deployment returns the same fixture for every rwa_id, which
  // would render as fabricated-looking duplicate rows — skip the scan there.
  if (document.body.dataset.mode === "mock") {
    state.scan.error = "Needs a live CMC_API_KEY — every mock-mode call returns the same sample asset.";
    state.scan.loaded = true;
    render();
    return;
  }

  state.scan.loading = true;
  state.scan.error = "";
  render();

  try {
    const candidates = state.assets.filter(hasWorkingId).slice(0, SCAN_N);
    const issuerMcap = new Map<string, number>();
    const spread: SpreadRow[] = [];
    const tokenMcapById = new Map<number, number>();
    let excluded = 0;

    await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (asset) => {
      try {
        const body = await api(`/api/quotes?rwa_id=${encodeURIComponent(String(asset.id))}&convert=USD`);
        const rec = body?.data?.rwa_assets?.[0] ?? body?.data;
        const tokens: Json[] = Array.isArray(rec?.tokens) ? rec.tokens : [];
        const valid = tokens.filter((t) => num(t?.price) > 0);

        for (const t of valid) {
          const issuer = String(t.issuer_name ?? t.issuer_id ?? "Unknown issuer");
          issuerMcap.set(issuer, (issuerMcap.get(issuer) ?? 0) + (num(t.market_cap) || 0));
          const cid = num(t.crypto_id);
          if (cid > 0) tokenMcapById.set(cid, (tokenMcapById.get(cid) ?? 0) + (num(t.market_cap) || 0));
        }

        if (valid.length >= 2) {
          const sorted = [...valid].sort((a, b) => num(a.price) - num(b.price));
          const low = sorted[0] as Json;
          const high = sorted[sorted.length - 1] as Json;
          const spreadPct = ((num(high.price) - num(low.price)) / num(low.price)) * 100;
          if (!Number.isFinite(spreadPct) || spreadPct <= 0.005) return;
          if (spreadPct > SPREAD_MAX_PCT) {
            excluded++; // near-certainly a unit mismatch or a stale quote, not a real spread
            return;
          }
          spread.push({
            asset,
            low: { symbol: low.symbol ?? "?", issuer: low.issuer_name ?? low.issuer_id ?? "—", price: num(low.price) },
            high: { symbol: high.symbol ?? "?", issuer: high.issuer_name ?? high.issuer_id ?? "—", price: num(high.price) },
            spreadPct,
            tokenCount: valid.length,
          });
        }
      } catch {
        /* one asset failing shouldn't sink the whole scan */
      }
    });

    spread.sort((a, b) => b.spreadPct - a.spreadPct);
    state.scan.spread = spread.slice(0, 20);
    state.scan.excluded = excluded;
    state.scan.issuerShare = [...issuerMcap.entries()]
      .map(([issuer, mcap]) => ({ issuer, mcap }))
      .sort((a, b) => b.mcap - a.mcap);
    state.scan.chainShare = await resolveChainShare(tokenMcapById);
    state.scan.scannedCount = candidates.length;
    state.scan.loaded = true;
  } catch (e) {
    state.scan.error = (e as Error).message;
  }
  state.scan.loading = false;
  render();
}

// Turns {crypto_id -> market cap} into {chain -> market cap} via
// /v2/cryptocurrency/info's `platform` field (chunked — CMC bulk-id endpoints
// have a practical URL-length ceiling, so ~100 ids per call).
async function resolveChainShare(tokenMcapById: Map<number, number>): Promise<ChainShare[]> {
  const ids = [...tokenMcapById.keys()];
  if (!ids.length) return [];

  const CHUNK = 100;
  const chainById = new Map<number, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const body = await api(`/api/crypto-info?id=${chunk.join(",")}`);
      const data: Json = body?.data ?? {};
      for (const key of Object.keys(data)) {
        const c = data[key];
        const id = num(c?.id ?? key);
        // No `platform` means the token is native to its own chain rather than
        // an ERC-20/SPL-style token issued on top of one.
        chainById.set(id, String(c?.platform?.name ?? c?.name ?? "Other / native chain"));
      }
    } catch {
      /* this chunk's tokens are left unattributed rather than failing the scan */
    }
  }

  const chainMcap = new Map<string, number>();
  for (const [id, mcap] of tokenMcapById) {
    const chain = chainById.get(id) ?? "Unknown chain";
    chainMcap.set(chain, (chainMcap.get(chain) ?? 0) + mcap);
  }
  return [...chainMcap.entries()].map(([chain, mcap]) => ({ chain, mcap })).sort((a, b) => b.mcap - a.mcap);
}

async function loadUsage(): Promise<void> {
  try {
    const body = await api("/api/usage");
    const plan = body?.data?.plan ?? {};
    const usage = body?.data?.usage?.current_month ?? {};
    state.usage.creditsUsed = num(usage.credits_used) || 0;
    state.usage.creditsLimit = num(plan.credit_limit_monthly) || 0;
    state.usage.rateLimitPerMin = num(plan.rate_limit_minute) || 0;
    state.usage.resetIn = String(plan.credit_limit_monthly_reset ?? "");
    state.usage.loaded = true;
  } catch (e) {
    state.usage.error = (e as Error).message;
  }
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

  if (!hasWorkingId(asset)) {
    detail.error =
      "CoinMarketCap has no working id for this record (rwa_id is null and rwa_slug isn't accepted by the API) — a small data gap on their side. The raw payload below is everything available.";
    detail.loading = false;
    render();
    return;
  }

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

// --- compare (up to 4 assets, side by side) -----------------------------------

function compareTrigger(): string {
  if (state.compare.size === 0 || state.compareOpen) return "";
  return `<button class="cmp-fab" data-cmpopen>Compare (${state.compare.size}) ↗</button>`;
}

function compareOverlay(): string {
  if (!state.compareOpen) return "";
  const rows = [...state.compare]
    .map((id) => state.assets.find((a) => String(a.id) === id))
    .filter((a): a is Asset => !!a);

  const metric = (label: string, get: (a: Asset) => string) =>
    `<tr><th>${esc(label)}</th>${rows.map((a) => `<td>${get(a)}</td>`).join("")}</tr>`;

  return `
  <div class="ov" data-cmpbackdrop>
    <div class="ov-card" role="dialog" aria-modal="true" aria-label="Compare assets">
      <button class="ov-x" data-cmpclose aria-label="Close">×</button>
      <h2>Compare</h2>
      ${
        rows.length
          ? `<div class="cmp-scroll">
               <table class="grid cmp-table">
                 <thead>
                   <tr>
                     <th></th>
                     ${rows
                       .map(
                         (a) => `<th>
                           ${esc(a.name)} <span class="sym">${esc(a.symbol)}</span>
                           <button class="cmp-x-small" data-cmpremove="${esc(String(a.id))}" aria-label="Remove ${esc(a.name)}">×</button>
                         </th>`,
                       )
                       .join("")}
                   </tr>
                 </thead>
                 <tbody>
                   ${metric("Type", (a) => `<span class="pill">${esc(a.type)}</span>`)}
                   ${metric("Rank", (a) => (a.rank ? `#${fmtNum(a.rank)}` : "—"))}
                   ${metric("Tokenised price", (a) => fmtUsd(a.price))}
                   ${metric("Market cap", (a) => fmtUsd(a.mcap))}
                   ${metric("24h volume", (a) => fmtUsd(a.vol))}
                   ${metric("Tokenised", (a) => (a.hasTokens ? "✓" : "—"))}
                 </tbody>
               </table>
             </div>`
          : `<p class="muted">Nothing selected — check the box next to an asset on the Assets tab.</p>`
      }
      ${rows.length ? `<button class="ov-raw" data-cmpclear>Clear all</button>` : ""}
    </div>
  </div>`;
}

function visibleAssets(): Asset[] {
  let rows = state.assets;
  if (state.watchlistOnly) rows = rows.filter((r) => state.watchlist.has(String(r.id)));
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

// Keeps tab/search/filter/sort in the URL so a specific view is linkable —
// never fatal if the History API is unavailable for some reason.
function syncUrl(): void {
  try {
    const p = new URLSearchParams();
    if (state.tab !== "assets") p.set("tab", state.tab);
    if (state.q) p.set("q", state.q);
    if (state.type !== "all") p.set("type", state.type);
    if (state.sort !== "mcap") p.set("sort", state.sort);
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  } catch {
    /* nice-to-have, never block a render over it */
  }
}

function usageBadge(): string {
  const u = state.usage;
  if (!u.loaded || !u.creditsLimit) return "";
  const pct = Math.min(100, (u.creditsUsed / u.creditsLimit) * 100);
  return `
    <div class="usage-badge" title="CoinMarketCap API credits used this month (resets ${esc(u.resetIn.toLowerCase())})">
      <span class="usage-bar"><span style="width:${pct.toFixed(2)}%"></span></span>
      <span>${fmtNum(u.creditsUsed)} / ${fmtNum(u.creditsLimit)} credits</span>
    </div>`;
}

function render(): void {
  syncUrl();
  const t = totals();
  const isLoading = state.tab === "discover" ? state.discover.loading : state.loading;
  const activeError = state.tab === "discover" ? state.discover.error : state.error;
  const body = isLoading
    ? `<div class="loading">Loading…</div>`
    : state.tab === "assets"
      ? assetsView(t)
      : state.tab === "issuers"
        ? issuersView()
        : state.tab === "spread"
          ? spreadView()
          : state.tab === "terminal"
            ? terminalView()
            : discoverView();

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <h1>Bedrock</h1>
        <p class="tag">Tokenised stocks, treasuries &amp; commodities · CoinMarketCap RWA API</p>
        ${usageBadge()}
      </div>
      <nav class="tabs">
        <button data-tab="assets" class="${state.tab === "assets" ? "on" : ""}">Assets</button>
        <button data-tab="spread" class="${state.tab === "spread" ? "on" : ""}">Spread</button>
        <button data-tab="issuers" class="${state.tab === "issuers" ? "on" : ""}">Issuers</button>
        <button data-tab="discover" class="${state.tab === "discover" ? "on" : ""}">New &amp; Upcoming</button>
        <button data-tab="terminal" class="${state.tab === "terminal" ? "on" : ""}">⌘ Terminal</button>
      </nav>
    </header>
    <div class="mock-banner">
      Serving bundled sample data — add <code>CMC_API_KEY</code> to <code>.env</code> and restart for live data.
    </div>
    ${activeError ? `<div class="error">${esc(activeError)}</div>` : ""}
    ${body}
    ${detailOverlay()}
    ${compareOverlay()}
    ${compareTrigger()}
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
      <label class="watch-toggle">
        <input type="checkbox" id="watchonly" ${state.watchlistOnly ? "checked" : ""} />
        ★ Watchlist only${state.watchlist.size ? ` (${fmtNum(state.watchlist.size)})` : ""}
      </label>
      <span class="count">${
        all.length > rows.length
          ? `${fmtNum(rows.length)} of ${fmtNum(all.length)} — refine to see more`
          : `${fmtNum(all.length)} shown`
      } · click a row for detail</span>
    </section>

    <table class="grid">
      <thead>
        <tr>
          <th class="cmp-th"></th>
          <th class="cmp-th"></th>
          <th>Asset</th><th>Type</th>
          <th class="r">Tokenised price</th>
          <th class="r">Market cap</th>
          <th class="r">24h volume</th>
          <th class="r">Tokenised</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((r, i) => {
            const id = esc(String(r.id));
            const watched = state.watchlist.has(String(r.id));
            return `
        <tr class="row" data-i="${i}" title="Open ${esc(r.name)} detail">
          <td class="cmp-cell">
            <button class="star-btn ${watched ? "on" : ""}" data-watch="${id}" aria-label="${
              watched ? "Remove from" : "Add to"
            } watchlist" title="${watched ? "Remove from" : "Add to"} watchlist">${watched ? "★" : "☆"}</button>
          </td>
          <td class="cmp-cell"><input type="checkbox" data-cmp="${id}" ${
            state.compare.has(String(r.id)) ? "checked" : ""
          } aria-label="Add ${esc(r.name)} to comparison" /></td>
          <td><strong>${esc(r.name)}</strong> <span class="sym">${esc(r.symbol)}</span></td>
          <td><span class="pill">${esc(r.type)}</span></td>
          <td class="r">${fmtUsd(r.price)}</td>
          <td class="r">${fmtUsd(r.mcap)}</td>
          <td class="r">${fmtUsd(r.vol)}</td>
          <td class="r">${r.hasTokens ? "✓" : "—"}</td>
        </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function issuerShareSection(): string {
  const s = state.scan;
  if (s.loading) {
    return `<section class="panel"><h2>Issuer market share</h2><p class="muted">Scanning the top ${SCAN_N} assets by market cap…</p></section>`;
  }
  if (s.error) {
    return `<section class="panel"><h2>Issuer market share</h2><p class="muted">${esc(s.error)}</p></section>`;
  }
  if (!s.issuerShare.length) return "";
  const top = s.issuerShare.slice(0, 10);
  const rest = s.issuerShare.slice(10).reduce((sum, r) => sum + r.mcap, 0);
  const bars = rest > 0 ? [...top, { issuer: "Other issuers", mcap: rest }] : top;
  return `
    <section class="panel">
      <h2>Issuer market share</h2>
      <p class="muted">
        Tokenised market cap by issuer, aggregated from each backing token's own
        quote across the top ${fmtNum(s.scannedCount)} assets by market cap —
        not the full ~7,900-asset universe.
      </p>
      ${barChart(
        bars.map((b) => ({ label: b.issuer, value: b.mcap })),
        fmtUsd,
      )}
    </section>`;
}

function issuersView(): string {
  const rows = [...state.issuers].sort((a, b) => num(b?.num_tokens) - num(a?.num_tokens));
  const totalTokens = rows.reduce((s, it) => s + (num(it?.num_tokens) || 0), 0);
  return `
    ${issuerShareSection()}
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
          .map((it) => {
            const site = String(it?.website ?? "");
            const host = site ? site.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
            return `
        <tr>
          <td><strong>${esc(it?.name ?? it?.issuer_name ?? "Unknown")}</strong></td>
          <td>${
            site
              ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a>`
              : "—"
          }</td>
          <td class="r">${fmtNum(it?.num_tokens ?? "—")}</td>
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

function spreadView(): string {
  const s = state.scan;
  if (s.loading) {
    return `<section class="panel"><h2>Wrapper spread</h2><p class="muted">Pulling live quotes for the top ${SCAN_N} assets by market cap — a few seconds…</p></section>`;
  }
  if (s.error) {
    return `<section class="panel"><h2>Wrapper spread</h2><p class="muted">${esc(s.error)}</p></section>`;
  }
  const rows = s.spread;
  return `
    <section class="panel">
      <h2>Wrapper spread</h2>
      <p class="muted">
        When the same real-world asset has more than one tokenised wrapper, this
        ranks how far the cheapest and priciest wrapper diverge <em>right now</em> —
        scanned live across the top ${fmtNum(s.scannedCount)} assets by market cap,
        capped at ${SPREAD_MAX_PCT}%. A snapshot of the market, not investment advice.
      </p>
      ${
        s.excluded > 0
          ? `<p class="muted cards-note">
               Excluded ${fmtNum(s.excluded)} pair${s.excluded === 1 ? "" : "s"} with an implausibly
               large gap (&gt;${SPREAD_MAX_PCT}%) — almost always different wrappers pricing the
               same asset in different units (e.g. per gram vs. per troy ounce) rather than a
               real premium, since the API gives no unit field to tell them apart.
             </p>`
          : ""
      }
      ${
        rows.length
          ? `<table class="grid">
               <thead>
                 <tr><th>Asset</th><th>Cheapest wrapper</th><th>Priciest wrapper</th><th class="r">Spread</th></tr>
               </thead>
               <tbody>
                 ${rows
                   .map(
                     (r, i) => `
                 <tr class="row" data-i="${i}" title="Open ${esc(r.asset.name)} detail">
                   <td><strong>${esc(r.asset.name)}</strong> <span class="sym">${esc(r.asset.symbol)}</span></td>
                   <td>${esc(r.low.symbol)} <span class="sym">${esc(r.low.issuer)}</span> · ${fmtUsd(r.low.price)}</td>
                   <td>${esc(r.high.symbol)} <span class="sym">${esc(r.high.issuer)}</span> · ${fmtUsd(r.high.price)}</td>
                   <td class="r">+${r.spreadPct.toFixed(2)}%</td>
                 </tr>`,
                   )
                   .join("")}
               </tbody>
             </table>`
          : `<p class="muted">No meaningful spread among wrappers in the scanned set right now.</p>`
      }
    </section>
  `;
}

// --- terminal: command lookup + dense dashboard --------------------------------

function findAsset(query: string): Asset | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    state.assets.find((a) => a.symbol.toLowerCase() === q) ??
    state.assets.find((a) => a.name.toLowerCase() === q) ??
    state.assets.find((a) => a.symbol.toLowerCase().startsWith(q)) ??
    state.assets.find((a) => a.name.toLowerCase().includes(q))
  );
}

function termList(items: Array<{ label: string; sub?: string; right: string }>, emptyMsg: string): string {
  if (!items.length) return `<p class="muted">${esc(emptyMsg)}</p>`;
  return `<ol class="term-list">${items
    .map(
      (it) =>
        `<li><span>${esc(it.label)}${it.sub ? ` <span class="sym">${esc(it.sub)}</span>` : ""}</span><span class="r">${it.right}</span></li>`,
    )
    .join("")}</ol>`;
}

function terminalView(): string {
  const scanEmptyMsg = state.scan.loading
    ? `Scanning the top ${SCAN_N} assets…`
    : state.scan.loaded
      ? "Scan complete — nothing to show here right now."
      : "Loading assets before the scan can start…";

  const movers = termList(
    state.assets.slice(0, 8).map((a) => ({ label: a.name, sub: a.symbol, right: fmtUsd(a.mcap) })),
    "Loading assets…",
  );
  const spreadList = termList(
    state.scan.spread
      .slice(0, 5)
      .map((r) => ({ label: r.asset.name, sub: r.asset.symbol, right: `+${r.spreadPct.toFixed(2)}%` })),
    scanEmptyMsg,
  );
  const launchedList = termList(
    state.discover.launched
      .slice(0, 5)
      .map((a) => ({ label: a.name, sub: a.symbol, right: a.rank ? `#${fmtNum(a.rank)}` : "—" })),
    state.discover.loading ? "Loading…" : "Nothing in the latest batch.",
  );
  const issuerList = termList(
    state.scan.issuerShare.slice(0, 6).map((r) => ({ label: r.issuer, right: fmtUsd(r.mcap) })),
    scanEmptyMsg,
  );
  const chainList = termList(
    state.scan.chainShare.slice(0, 6).map((r) => ({ label: r.chain, right: fmtUsd(r.mcap) })),
    scanEmptyMsg,
  );

  return `
    <section class="panel term-cmd">
      <h2>Lookup</h2>
      <form data-termform>
        <input id="termq" type="search" autocomplete="off" placeholder="Ticker or name — NVDA, Gold, Robinhood…" value="${esc(state.terminalQuery)}" />
        <button type="submit">Go ↵</button>
      </form>
      <p class="muted">${
        state.terminalError
          ? esc(state.terminalError)
          : "Opens the full research view: live quote, company facts, SEC EDGAR, CoinMarketCap links, backing tokens."
      }</p>
    </section>

    <div class="term-grid">
      <section class="panel"><h2>Top by market cap</h2>${movers}</section>
      <section class="panel"><h2>Biggest wrapper spreads</h2>${spreadList}</section>
      <section class="panel"><h2>Newly launched</h2>${launchedList}</section>
      <section class="panel"><h2>Issuer share</h2>${issuerList}</section>
      <section class="panel"><h2>Chain share</h2>${chainList}</section>
      <section class="panel">
        <h2>API usage</h2>
        ${
          state.usage.loaded
            ? `<p class="muted">
                 ${fmtNum(state.usage.creditsUsed)} / ${fmtNum(state.usage.creditsLimit)} credits used this month ·
                 resets ${esc(state.usage.resetIn.toLowerCase())} · ${fmtNum(state.usage.rateLimitPerMin)} req/min limit
               </p>`
            : `<p class="muted">${state.usage.error ? esc(state.usage.error) : "Loading…"}</p>`
        }
      </section>
    </div>
  `;
}

function bind(): void {
  app.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as typeof state.tab;
      if (state.tab === "issuers" && state.issuers.length === 0) void loadIssuers();
      else if (state.tab === "discover" && !state.discover.loaded) void loadNewAndUpcoming();
      else render();
      // Issuer share, Spread and the Terminal dashboard all read the same
      // scan; trigger it (idempotent) whichever tab opens it first.
      if (state.tab === "issuers" || state.tab === "spread" || state.tab === "terminal") void loadMarketScan();
      if (state.tab === "terminal" && !state.discover.loaded) void loadNewAndUpcoming();
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
  app.querySelector<HTMLInputElement>("#watchonly")?.addEventListener("change", (e) => {
    state.watchlistOnly = (e.target as HTMLInputElement).checked;
    render();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-watch]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.watch as string;
      if (state.watchlist.has(id)) state.watchlist.delete(id);
      else state.watchlist.add(id);
      saveWatchlist(state.watchlist);
      render();
    });
  });

  app.querySelector<HTMLFormElement>("[data-termform]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = app.querySelector<HTMLInputElement>("#termq");
    state.terminalQuery = input?.value ?? "";
    const hit = findAsset(state.terminalQuery);
    if (hit) {
      state.terminalError = "";
      void openDetail(hit);
    } else {
      state.terminalError = state.terminalQuery.trim()
        ? `No match for "${state.terminalQuery.trim()}" in the loaded assets.`
        : "";
      render();
    }
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
      } else if (state.tab === "spread") {
        const row = state.scan.spread[i];
        if (row) void openDetail(row.asset);
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("[data-cmp]").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      const id = cb.dataset.cmp as string;
      if (cb.checked) {
        if (state.compare.size >= 4) {
          cb.checked = false;
          return;
        }
        state.compare.add(id);
      } else {
        state.compare.delete(id);
      }
      render();
    });
  });

  app.querySelector<HTMLButtonElement>("[data-cmpopen]")?.addEventListener("click", () => {
    state.compareOpen = true;
    render();
  });
  const cmpBackdrop = app.querySelector<HTMLElement>("[data-cmpbackdrop]");
  cmpBackdrop?.addEventListener("click", (e) => {
    if (e.target === cmpBackdrop) {
      state.compareOpen = false;
      render();
    }
  });
  app.querySelector<HTMLButtonElement>("[data-cmpclose]")?.addEventListener("click", () => {
    state.compareOpen = false;
    render();
  });
  app.querySelector<HTMLButtonElement>("[data-cmpclear]")?.addEventListener("click", () => {
    state.compare.clear();
    state.compareOpen = false;
    render();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-cmpremove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.compare.delete(btn.dataset.cmpremove as string);
      render();
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
  if (e.key !== "Escape") return;
  if (detail.open) closeDetail();
  else if (state.compareOpen) {
    state.compareOpen = false;
    render();
  }
});

// Deep-linking straight into a tab that reads state.assets (Spread, Issuers'
// share chart, Terminal) must wait for loadAssets() to actually populate it —
// loadMarketScan() no-ops on an empty list rather than "completing" with
// nothing, so chain the retry off this promise instead of racing it.
const assetsReady = loadAssets();
void loadUsage();
void assetsReady.then(() => {
  if (state.tab === "issuers" || state.tab === "spread" || state.tab === "terminal") void loadMarketScan();
  if (state.tab === "issuers") void loadIssuers();
});
if (state.tab === "discover" || state.tab === "terminal") void loadNewAndUpcoming();
