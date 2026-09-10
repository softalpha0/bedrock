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

- **Assets view** — every tracked RWA with tokenised price, tokenised market cap,
  24h tokenised volume and token count; search, filter by asset type
  (`stock`, `government_security`, `etf`, `commodity`, `real_estate`, `currency`),
  and sort. Aggregate cards for total tokenised market cap and volume, plus a
  top-12 bar chart.
- **Issuers view** — every token issuer and the tokens linked to each.
- **Raw drawer** — click any row to expand the exact CMC JSON for that record.
- **Mock mode** — with no key set, the server serves bundled sample fixtures so
  the UI runs immediately. A banner makes the data source obvious.

---

## CMC API endpoints used

All under base URL `https://pro-api.coinmarketcap.com`, authenticated with the
`X-CMC_PRO_API_KEY` header.

| App route | CMC endpoint | Used for |
|---|---|---|
| `/api/assets` | `GET /v5/real-world-assets/assets/list` | main asset table, aggregates, chart |
| `/api/issuers` | `GET /v5/real-world-assets/issuers/list` | issuers table |
| `/api/issuer` | `GET /v5/real-world-assets/issuers` | single issuer + linked tokens |
| `/api/quotes` | `GET /v5/real-world-assets/quotes/latest` | latest quote for specific assets |
| `/api/info` | `GET /v5/real-world-assets/info` | static metadata (ISIN, underlying, issuers) |
| `/api/map` | `GET /v5/real-world-assets/map` | id / slug / symbol map |
| `/api/market-pairs` | `GET /v5/real-world-assets/market-pairs/list` | active markets for an RWA token |

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

**What it made possible:** one endpoint (`assets/list`) returns tokenised price,
market cap and 24h volume already aggregated across every issuer of a given
real-world asset, so a useful cross-issuer view of the whole tokenised-asset
market is a single call. The `issuers` endpoints make the asset↔issuer graph
explicit, which is the interesting structure here.

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
