import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

/**
 * Persistent raw-response cache for DataDoe exports.
 *
 * Why this exists: every DataDoe export consumes an org-wide "AI Token". A single dashboard
 * load fires ~13 exports and each range switch ~9 more, so ordinary repeated use (browser
 * reloads, re-opening sections, revisiting a range) burned tokens for data that had not
 * changed. This layer stores each completed export's RAW rows plus full provenance metadata,
 * keyed deterministically by the request that produced it, so repeated identical requests are
 * served from disk with ZERO further DataDoe exports until an explicit refresh (manual "Sync").
 *
 * The raw rows are preserved verbatim — normalization/aggregation happens downstream in the
 * controllers and never mutates what is stored here, so the raw response is never destroyed.
 */

export const CACHE_SCHEMA_VERSION = 1;

/**
 * Default freshness window used only to LABEL an entry fresh-vs-stale and to decide when to
 * suggest a manual Sync. It never auto-fetches, never consumes tokens, and never changes which
 * rows are returned. 60 minutes is derived from the dashboard's own stated DataDoe update
 * cadence (the footer documents "Sales & ads hourly · fees on settlement close · inventory
 * every 30 min"), so it is a technically sensible default rather than an invented business
 * rule. Override with DATADOE_CACHE_TTL_MS. If a stricter/looser staleness policy is required
 * for business reasons, that is a product decision — flagged, not hard-coded here.
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function cacheTtlMs(): number {
  const raw = Number(process.env.DATADOE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function cacheDir(): string {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

export interface CacheKeyParams {
  sellerId: string;
  sourceName: string;
  columns?: string[];
  from?: string;
  to?: string;
  all?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * Deterministic key over exactly the dimensions that change the returned rows: seller, source,
 * the requested column set (or the "__ALL__" sentinel when the caller defaults to every column
 * — stable per source without needing a sources lookup), date window, and pagination. Distinct
 * datasets therefore never collide onto one key, and two identical requests always resolve to
 * the same key (enabling both disk reuse and in-flight de-duplication).
 */
export function computeCacheKey(p: CacheKeyParams): string {
  const canonical = {
    sellerId: p.sellerId,
    sourceName: p.sourceName,
    columns: p.columns && p.columns.length ? [...p.columns].sort() : "__ALL__",
    from: p.from ?? null,
    to: p.to ?? null,
    all: !!p.all,
    page: p.all ? null : p.page ?? null,
    pageSize: p.all ? null : p.pageSize ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 40);
}

export interface StoredSource {
  id: string;
  name: string;
  tableName: string;
  type: string;
}

export interface CacheEntry<T = unknown> {
  key: string;
  schemaVersion: number;
  sellerId: string; // seller/account context
  sourceName: string; // DataDoe source
  source: StoredSource | null; // source/table + metadata
  exportId: string | null; // DataDoe export/request id that produced these rows
  from: string | null; // requested date range
  to: string | null;
  columns: string[]; // schema of the stored rows
  all: boolean;
  page: number | null;
  pageSize: number | null;
  retrievedAt: string; // retrieval timestamp (ISO 8601)
  status: string; // processing status when stored (always "COMPLETED" — we never persist errors)
  rowCount: number;
  rows: T[]; // RAW DataDoe rows, preserved verbatim
}

// Hot in-memory layer over the disk store. Disk is the source of truth so the cache survives
// process restarts; memory just avoids re-reading files within a process.
const memory = new Map<string, CacheEntry>();

function filePath(key: string): string {
  return path.join(cacheDir(), key + ".json");
}

export async function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
  const hot = memory.get(key);
  if (hot) return hot as CacheEntry<T>;
  try {
    const buf = await fs.readFile(filePath(key), "utf8");
    const entry = JSON.parse(buf) as CacheEntry<T>;
    // Ignore entries written by an incompatible older schema rather than misinterpreting them.
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    memory.set(key, entry as CacheEntry);
    return entry;
  } catch {
    // Missing file or unreadable/torn JSON → treat as a cache miss (the next fetch rewrites it).
    return null;
  }
}

export async function writeCache<T>(key: string, entry: CacheEntry<T>): Promise<void> {
  memory.set(key, entry as CacheEntry);
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  // Write to a temp file then rename so a crash mid-write can never truncate a previously-valid
  // entry (readCache would just see the old file or a miss, never corruption).
  const tmp = filePath(key) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(entry), "utf8");
  await fs.rename(tmp, filePath(key));
}

export type ServedStatus = "fresh" | "cached" | "stale" | "unavailable";

/** Classify a stored entry served from cache as within-TTL ("cached") or beyond-TTL ("stale"). */
export function classifyAge(retrievedAt: string): "cached" | "stale" {
  const age = Date.now() - new Date(retrievedAt).getTime();
  return age <= cacheTtlMs() ? "cached" : "stale";
}

// In-flight de-duplication: if an identical export is already being fetched, a second caller
// awaits the same promise instead of firing a duplicate export.
const inflight = new Map<string, Promise<CacheEntry>>();

export async function fetchWithDedup<T>(
  key: string,
  fetcher: () => Promise<CacheEntry<T>>
): Promise<CacheEntry<T>> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<CacheEntry<T>>;
  const p = (async () => {
    try {
      return await fetcher();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p as Promise<CacheEntry>);
  return p as Promise<CacheEntry<T>>;
}

/** Test-only: reset in-memory hot layer and in-flight map (disk store is untouched). */
export function __resetMemory(): void {
  memory.clear();
  inflight.clear();
}
