# DoraHacks BUIDL submission — Bedrock

Paste-ready copy for the submission form. Delete this file from the repo if you
don't want it public — it's just a scratchpad.

---

**Name:** Bedrock

**Tagline:** An explorer for tokenised real-world assets, built on the CoinMarketCap RWA API.

**Track:** Real World Assets

**Repo:** https://github.com/softalpha0/bedrock
**Live demo:** https://bedrock-rygi.onrender.com  (`/api/health` → `{"ok":true,"mode":"live"}`)

---

## Description

Bedrock turns the CoinMarketCap RWA API into a browsable view of the whole
tokenised-real-world-asset market — **7,942** tokenised assets (equities, US
Treasuries, money-market funds, commodities) and the **25 issuers** behind them.

- Ranks assets by tokenised market cap, with aggregate market cap / 24h volume
- Filter by asset type (`stock`, `commodity`, `government-security`, `etf`, …),
  search, and sort; top-12 bar chart
- **Asset detail view** (click any row): live quote, company facts (industry,
  primary exchange, founded, employees), links to the company site and its
  **SEC EDGAR** filings via the `cik` field, the individual **tokens backing the
  asset** with issuers, a Q&A description, and a raw-JSON toggle
- **New & Upcoming**: `rwa_id` is assigned sequentially as CMC onboards assets,
  so the tail of `map` is its newest additions. Split into **Newly launched**
  (already has a token) and **Upcoming** (tracked, no token yet) — the RWA API
  exposes no dedicated "upcoming" endpoint, so this is the honest proxy for it
- Issuers view: every issuer and how many instruments it has tokenised

The API key never reaches the browser. A small Node/Express service holds it,
exposes an allow-list of RWA endpoints, and caches responses ~60s. Front end is
dependency-free TypeScript (Vite build), served by the same process.

## CMC API endpoints used

Base `https://pro-api.coinmarketcap.com`, header `X-CMC_PRO_API_KEY`.

| Endpoint | Used for |
|---|---|
| `GET /v5/real-world-assets/assets/list` | main table, aggregates, chart — paginated across all ~7,900 |
| `GET /v5/real-world-assets/issuers/list` | issuers view |
| `GET /v5/real-world-assets/quotes/latest` | asset detail: live quote + backing tokens |
| `GET /v5/real-world-assets/info` | asset detail: company facts, `cik`, Q&A description |
| `GET /v2/cryptocurrency/info` | asset detail: `crypto_id` → CoinMarketCap page slug for each backing token |
| `GET /v5/real-world-assets/issuers` | proxied (single issuer + linked tokens) |
| `GET /v5/real-world-assets/map` | New & Upcoming: tail-page scan by `rwa_id` for the newest additions |
| `GET /v5/real-world-assets/market-pairs/list` | proxied — 1006 "plan doesn't support" on Startup tier |

Client + proxy code: `src/server/cmc.ts`, `src/server/routes.ts`.

## Evidence of a real API call

`npm run verify` (`scripts/verify.ts`) makes authenticated calls and writes raw
responses to `evidence/`. Excerpt from `evidence/verify-output.txt`:

```
GET /v5/real-world-assets/assets/list?start=1&limit=10&convert=USD
  HTTP 200 in 709ms
  status: {"timestamp":"2026-09-10T...","error_code":"0","error_message":"","elapsed":13,"credit_count":1}
  first record:
    { "name": "Gold", "symbol": "GOLD", "slug": "gold", "rwa_id": 1,
      "asset_type": "commodity", "rwa_rank": 1, "has_tokens": true,
      "average_tokenized_price": 4324.99, "tokenized_market_cap": 4611465267.35,
      "tokenized_volume_24h": 472394233.50 }

GET /v5/real-world-assets/issuers/list?start=1&limit=10
  HTTP 200 in 264ms
  first record:
    { "name": "Backed Assets", "website": "https://assets.backed.fi/",
      "issuer_id": "6878977dcbbf471de3366e85", "num_tokens": 1176 }
```

Full JSON: `evidence/assets-list.json`, `evidence/issuers-list.json`.

## What the API made possible

`assets/list` returns tokenised price, market cap and 24h volume already
aggregated across every issuer of a given real-world asset — so a cross-issuer
view of the entire market is one paginated call, no per-issuer stitching. The
`issuers` endpoints make the asset↔issuer structure explicit, which is the
interesting shape of this dataset.

## Where it got in the way

- `status.error_code` is a **string** (`"0"`) on the RWA endpoints and a number
  elsewhere in the Pro API; `"0"` is also truthy, so both `!== 0` and `if(code)`
  checks misfire. Had to coerce with `Number()`.
- **No per-asset token count** in `assets/list` — only a `has_tokens` boolean.
  The count lives on `issuers/list` (`num_tokens`) instead.
- Quote fields are duplicated: top-level `tokenized_*` **and** a `quotes[]` array
  entry, with nothing in the docs saying which is canonical.
- Issuer identity is a bare Mongo `issuer_id` (`6878977dcbbf…`) — no slug.
- The response envelope (`data.rwa_assets`, `total_size`, `has_more`) isn't in
  the public reference; discovered by calling the endpoint.
- `market-pairs/list` returns `1006` "plan doesn't support this endpoint" on the
  Startup tier, with nothing in the docs saying which RWA endpoints need a higher
  tier — only discoverable at runtime.
- RWA assets have **no page on coinmarketcap.com** (`/rwa/*` 404s). The backing
  tokens do, but the RWA endpoints only expose their numeric `crypto_id` — a
  second `/v2/cryptocurrency/info` call is needed to get the `slug` for the
  public URL. The detail view stitches that together plus `cik` → SEC EDGAR.
- No `sort` on `assets/list` (any value → `4001 Invalid parameter`) and no
  "recently added" / "upcoming" endpoint — New & Upcoming works only because
  `rwa_id` happens to be assigned in onboarding order, discovered by scanning
  the tail of `map`.

---

## X / Twitter post

**Option A (short):**

> Built **Bedrock** for #BuildwithCMC 🪨
>
> An explorer for tokenised real-world assets — 7,942 tokenised stocks, Treasuries
> & commodities and their 25 issuers, straight from the CoinMarketCap RWA API.
>
> Live: https://bedrock-rygi.onrender.com
> Demo + code: <DORAHACKS_LINK>
>
> #BuildwithCMC

**Option B (with the friction note judges like):**

> #BuildwithCMC submission: **Bedrock** 🪨 — a browsable view of the entire
> tokenised-RWA market (7,942 assets, 25 issuers) on the CoinMarketCap RWA API.
>
> Key stays server-side, 7 RWA endpoints, honest aggregates across all 7,942.
>
> Demo video + repo: <DORAHACKS_LINK>
> Try it: https://bedrock-rygi.onrender.com

Replace `<DORAHACKS_LINK>` with your BUIDL page URL and attach the screen
recording. Keep the hashtag exactly `#BuildwithCMC`.
