import "./landing.css";

// A couple of the stat tiles are live numbers, not copy — pulled from the same
// /api/* routes the app itself uses, so the landing page is never out of sync
// with what a visitor sees after clicking through.
async function loadLiveStats(): Promise<void> {
  const assetsEl = document.querySelector<HTMLElement>("[data-stat=assets]");
  const issuersEl = document.querySelector<HTMLElement>("[data-stat=issuers]");
  try {
    const [assetsRes, issuersRes] = await Promise.all([
      fetch("/api/assets?limit=1"),
      fetch("/api/issuers?limit=1"),
    ]);
    const [assetsBody, issuersBody] = await Promise.all([assetsRes.json(), issuersRes.json()]);
    const assetsTotal = Number(assetsBody?.data?.total_size);
    const issuersTotal = Number(issuersBody?.data?.total_size);
    if (assetsEl && Number.isFinite(assetsTotal)) {
      assetsEl.textContent = new Intl.NumberFormat("en-US").format(assetsTotal);
    }
    if (issuersEl && Number.isFinite(issuersTotal)) {
      issuersEl.textContent = new Intl.NumberFormat("en-US").format(issuersTotal);
    }
  } catch {
    // Cold-starting free-tier host, or offline — the static fallback text
    // already in the markup just stays put.
  }
}

void loadLiveStats();
