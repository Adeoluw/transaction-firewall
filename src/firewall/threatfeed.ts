// Live threat intelligence. Merges the ScamSniffer open-source drainer
// blocklist (fetched at startup, cached on disk) with the local threat list.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import threatlist from "../../config/threatlist.json" with { type: "json" };

const FEED_URL =
  "https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = join(ROOT, "data");
const CACHE_FILE = join(CACHE_DIR, "scamsniffer-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const LOCAL: Record<string, { label: string }> = threatlist.addresses;

const threatSet = new Set<string>(Object.keys(LOCAL));
let feedCount = 0;
let feedSource = "local list only";

export function threatIntelStatus() {
  return { entries: threatSet.size, feedEntries: feedCount, source: feedSource };
}

/** Return up to n REAL drainer addresses from the live feed (excludes the
 * demo's local fake villain). Used by the real-world proof. */
export function sampleFeedAddresses(n: number): string[] {
  const out: string[] = [];
  for (const a of threatSet) {
    if (LOCAL[a]) continue; // skip the local demo entries
    out.push(a);
    if (out.length >= n) break;
  }
  return out;
}

export function isThreat(address: string): { hit: boolean; label?: string } {
  const addr = address.toLowerCase();
  if (!threatSet.has(addr)) return { hit: false };
  return { hit: true, label: LOCAL[addr]?.label ?? "ScamSniffer drainer blocklist" };
}

function loadAddresses(list: string[]) {
  for (const a of list) threatSet.add(a.toLowerCase());
  feedCount = list.length;
}

/** Fetch/refresh the live feed. Never throws - the firewall must still run offline. */
export async function initThreatIntel(): Promise<void> {
  try {
    if (existsSync(CACHE_FILE)) {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      if (Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        loadAddresses(cache.addresses);
        feedSource = `ScamSniffer (cached ${new Date(cache.fetchedAt).toISOString()})`;
        return;
      }
    }
  } catch {
    /* corrupt cache - refetch */
  }

  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const addresses = (await res.json()) as string[];
    loadAddresses(addresses);
    feedSource = "ScamSniffer (live)";
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), addresses }));
  } catch (err) {
    // Offline or feed down: try stale cache, else local list only.
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      loadAddresses(cache.addresses);
      feedSource = "ScamSniffer (stale cache)";
    } catch {
      feedSource = `local list only (feed unavailable: ${(err as Error).message})`;
    }
  }
}
