import { cmcGet } from "./cmc.js";

// Small in-memory TTL cache. CMC RWA data refreshes about once a minute and
// credits are finite, so identical requests inside the window are served from
// memory. Good enough for a single-process hackathon deployment.
const TTL_MS = Number(process.env.CACHE_TTL_MS) || 60_000;

type Entry = { at: number; value: unknown };
const store = new Map<string, Entry>();

export async function cachedCmcGet(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const key =
    endpoint +
    "?" +
    new URLSearchParams([...Object.entries(params)].sort(([a], [b]) => a.localeCompare(b))).toString();

  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const value = await cmcGet(endpoint, params);
  store.set(key, { at: now, value });
  return value;
}
