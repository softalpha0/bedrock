# Bedrock

An explorer for **tokenised real-world assets** — tokenised equities, US Treasuries,
money-market funds, commodities and the issuers behind them — built entirely on the
**CoinMarketCap Real World Assets (RWA) API**.

> Submission for the **Build with CMC: API Hackathon** · Track: **Real World Assets**
>
> **Live demo:** https://bedrock-rygi.onrender.com &nbsp;(`/api/health` returns `{"ok":true,"mode":"live"}`)
> — free Render instance, sleeps after 15 min idle; first request may take ~50s to wake.

The browser never sees the API key. A small Node/Express service holds the key,
proxies an allow-list of RWA endpoints, caches responses for ~60s, and serves a
zero-dependency TypeScript single-page front end that ranks assets by tokenised
market cap, breaks them down by asset type, and lets you drill into the raw
payload and the issuer graph.

---

## What it does

- **Assets view** — the top 1,000 RWAs by tokenised market cap (the API tracks
  ~7,900) with tokenised price, market cap and 24h volume; search, filter by
  asset type (`stock`, `commodity`, `government-security`, `etf`, …), sort.
  Aggregate cards plus a top-12 bar chart.
- **Asset detail** — click any row for a research view built from `info` +
  `quotes/latest`: live quote, company facts (industry, primary exchange,
  founded, employees), links to the company site, its **SEC EDGAR** filings (via
  the `cik` field), and its **CoinMarketCap page**, plus every individual
  **token backing the asset** — each linked to its own CoinMarketCap profile
  (resolved from `crypto_id` via `/v2/cryptocurrency/info`) — a Q&A description,
  and a raw-JSON toggle.
- **New & Upcoming** — CoinMarketCap assigns `rwa_id` sequentially as it onboards
  assets, so the tail of `map` (highest ids) is its most recent additions. Split
  into **Newly launched** (`has_tokens: true` — already backed by a live token)
  and **Upcoming** (`has_tokens: false` — recognised as an RWA candidate, not yet
  tokenised). The RWA API has no dedicated "upcoming" endpoint; this is the most
  honest signal it exposes, and it's labelled as such in the UI.
- **Wrapper spread** — the same real-world asset is often tokenised by several
  issuers at once (e.g. Robinhood's, Ondo's and Backed's NVDA wrapper). This ranks
  assets by how far their cheapest and priciest wrapper diverge *right now*,
  computed live from `quotes/latest`'s per-token prices across the top 80 assets
  by market cap. Spreads over 20% are excluded and counted separately — almost
  always a unit mismatch (a gold wrapper priced per gram vs. one priced per troy
  ounce) rather than a real premium; see [Notes on the API](#notes-on-the-api).
- **Compare** — check up to 4 assets on the Assets tab and see them side by side
  (type, rank, price, market cap, volume) in a floating panel, from anywhere in
  the app.
- **Issuers view** — every token issuer and how many instruments it has
  tokenised, plus an **issuer market-share chart** built from the same
  wrapper-spread scan (tokenised market cap aggregated by issuer).
- **Terminal** — a command box (type a ticker or name, hit enter, get the full
  research view — no tab-hopping) above a dense dashboard: top movers, biggest
  wrapper spreads, newest launches, issuer share and **chain share**, all in one
  screen.
- **Chain share** — the hackathon explicitly frames CMC as chain-neutral, so
  Bedrock breaks the same 80-asset scan down by blockchain instead of just
  issuer — Ethereum, Solana, Arbitrum, BNB, … — resolved from each backing
  token's `crypto_id` via `/v2/cryptocurrency/info`'s `platform` field.
- **Watchlist** — star any asset; it's saved in the browser (no account, no
  server) and a "Watchlist only" toggle filters the Assets table to it.
- **Compare** — check up to 4 assets on the Assets tab and see them side by side
  (type, rank, price, market cap, volume) in a floating panel, from anywhere in
  the app.
- **Shareable URLs** — tab, search, type filter and sort are encoded in the URL
  (`?tab=spread&q=nvidia`), so any view is linkable or bookmarkable.
- **Mock mode** — with no key set, the server serves bundled sample fixtures so
  the UI runs immediately (Wrapper spread, issuer share and chain share are
  skipped in this mode with an explanation, since every mock call returns the
  same fixture). A banner makes the data source obvious.

---

## CMC API endpoints used

All under base URL `https://pro-api.coinmarketcap.com`, authenticated with the
`X-CMC_PRO_API_KEY` header.

| App route | CMC endpoint | Used for |
|---|---|---|
| `/api/assets` | `GET /v5/real-world-assets/assets/list` | main asset table, aggregates, chart (paginated across all ~7,900) |
| `/api/issuers` | `GET /v5/real-world-assets/issuers/list` | issuers table |
| `/api/quotes` | `GET /v5/real-world-assets/quotes/latest` | asset detail (live quote + backing tokens) and, scanned across 80 assets, Wrapper spread + issuer/chain share |
| `/api/info` | `GET /v5/real-world-assets/info` | asset detail: company facts, `cik`, Q&A description |
| `/api/crypto-info` | `GET /v2/cryptocurrency/info` | asset detail: `crypto_id` → CoinMarketCap page slug; scan: `crypto_id` → chain (`platform.name`) |
| `/api/issuer` | `GET /v5/real-world-assets/issuers` | proxied; single issuer + linked tokens |
| `/api/map` | `GET /v5/real-world-assets/map` | New & Upcoming: tail-page scan by `rwa_id` for recent additions |
| `/api/market-pairs` | `GET /v5/real-world-assets/market-pairs/list` | proxied — **returns 1006 on Startup tier** (see notes) |

The request/response code lives in [`src/server/cmc.ts`](src/server/cmc.ts) and
[`src/server/routes.ts`](src/server/routes.ts).

---

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env      # then paste your CMC key into CMC_API_KEY
npm run dev                # web on http://localhost:5173, API on :8787
```

Without a key it still runs — in **mock mode** against `fixtures/`.

### Production

```bash
npm run build              # bundles the SPA to dist/web
npm start                  # single process serves the SPA + /api on :8787
```

Deploy target: any Node host. The only required env var is `CMC_API_KEY`; `PORT`
is read from the environment when the host sets it (defaults to `8787`).

- **Render** — [`render.yaml`](render.yaml) is a Blueprint: *New > Blueprint*,
  select this repo, set `CMC_API_KEY` as a secret. Health check: `/api/health`.
- **Docker** (Railway / Fly / a VPS) — [`Dockerfile`](Dockerfile):
  `docker build -t bedrock . && docker run -p 8787:8787 -e CMC_API_KEY=... bedrock`
- **Anything else** — build `npm run build`, start `npm start`.

---

## Evidence of a real API call

```bash
npm run verify
```

This makes authenticated calls to `/v5/real-world-assets/assets/list` and
`/v5/real-world-assets/issuers/list`, prints the HTTP status, the CMC `status`
object and the first record, and writes the full raw responses to `evidence/`
(git-ignored — commit a sanitised copy for the submission). Source:
[`scripts/verify.ts`](scripts/verify.ts).

---

## Getting the hackathon API key

1. Create a free account at <https://coinmarketcap.com/api>.
2. Register for the hackathon on DoraHacks; submit the **email on your CMC
   account**.
3. Your existing key is upgraded to **Startup tier** for the event window.
4. Copy the key from the CMC developer dashboard into `.env`.

Never commit `.env` or paste the key into the front end — `.gitignore` already
excludes it.

---

## Notes on the API

**What it made possible:** `assets/list` returns tokenised price, market cap and
24h volume already aggregated across every issuer of a given real-world asset, so
a cross-issuer view of the whole market is one paginated call. `quotes/latest`
then breaks a single asset back down into the individual tokens behind it (with
issuer, price and market cap per token), and `info` carries genuinely useful
reference data — industry, primary exchange, employee count, SEC `cik`, and a
readable Q&A explainer — so a per-asset research page needs no other source.

**Where it got in the way** (running list, from building this):

- **`status.error_code` is a string** (`"0"`) on the RWA endpoints, where the
  rest of the CMC Pro API returns it as a number. Naive `error_code !== 0` checks
  silently pass; `"0"` is also truthy, so `if (error_code)` misfires. We coerce
  with `Number()` in [`src/server/cmc.ts`](src/server/cmc.ts).
- **No per-asset token count in `assets/list`** — just a `has_tokens` boolean.
  You have to call `issuers/list` (which *does* have `num_tokens`) or the
  per-asset endpoint to know how many tokens back an asset.
- **Two parallel copies of the quote fields.** Each asset carries
  `average_tokenized_price` / `tokenized_market_cap` / `tokenized_volume_24h` at
  the top level *and* again inside a `quotes[]` array entry. The docs don't say
  which is canonical or when they can diverge, so the client reads top-level
  first and falls back to `quotes[]`.
- **Issuer identity is a bare Mongo `issuer_id`** (`6878977dcbbf...`) with no
  human-readable slug, so issuer links in a URL look opaque.
- **Response envelope isn't in the public docs.** The `data.rwa_assets` /
  `data.issuers` wrapper plus `total_size` / `has_more` pagination fields had to
  be discovered by calling the endpoint — see `evidence/`.
- **`market-pairs/list` fails on Startup tier** with `error_code` `1006`,
  "Your API Key subscription plan doesn't support this endpoint" — even though
  the plan lists 54 endpoints enabled. Nothing in the RWA reference flags which
  endpoints need a higher tier, so this is only discoverable at runtime. The
  route is still proxied; the UI just doesn't depend on it.
- **RWA assets have no page on coinmarketcap.com yet** (`/rwa/*` and
  `/currencies/<rwa-slug>/` both 404). Each *backing token* does have a CMC page,
  but the RWA endpoints only give its numeric `crypto_id` — turning that into the
  `slug` the public URL needs takes a second, non-RWA call to
  `/v2/cryptocurrency/info`. An RWA response carrying the token `slug` (or a
  ready URL) directly would remove that round-trip.
- **No unit field on backing tokens.** Building the Wrapper spread view, several
  "wrappers" of the same asset turned out priced 30x apart — e.g. a gold token at
  ~$140 next to one at ~$4,350. Both are correct; one is denominated per gram,
  the other per troy ounce (≈31.1g), and nothing in `quotes/latest` says so. Same
  pattern on silver. Naively comparing `tokens[].price` across wrappers is
  unsafe without a unit (or ounce-equivalent price) field; we filter spreads
  over 20% and count them separately rather than presenting them as real.
- The `info` endpoint's `about.description` (a solid Q&A explainer) and `cik`
  (→ SEC EDGAR) are great for equities, but there's no equivalent reference
  content for commodities or funds.
- **A small number of `assets/list` records have `rwa_id: null`** — 4 of the top
  1,000 by market cap, including "Alphabet Inc." (a duplicate of the properly
  populated "Alphabet Inc Class A") and "Berkshire Hathaway Inc.". Worse, they
  have *no* working lookup at all: `quotes/latest?rwa_slug=<slug>` and
  `info?rwa_slug=<slug>` both return `4001 Invalid parameter`, even though
  `rwa_slug` is accepted as a parameter name elsewhere in the reference. Bedrock
  detects this (`hasWorkingId`) and skips the live calls with a clear message
  instead of firing a doomed request.
- **No `sort` parameter on `assets/list`** — any value (`id`, `date_added`,
  `market_cap`, …) returns `4001 Invalid parameter`; ordering is fixed to
  `rwa_rank`. There's also no "recently added" or "upcoming" endpoint. Building
  New & Upcoming meant noticing that `rwa_id` is assigned in onboarding order and
  scanning the tail of `map` instead — it works, but a `sort=date_added` option
  or a dedicated endpoint would make "what's new" a one-call answer.

---

## Project layout

```
src/server/   Express service: CMC client, TTL cache, allow-listed proxy routes
src/web/      Zero-dependency TypeScript SPA (tables, filters, SVG bar chart)
scripts/      verify.ts — real API call + evidence capture
fixtures/     Sample RWA payloads used in mock mode
```

## License

MIT — see [LICENSE](LICENSE).
