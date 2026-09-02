import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { computeDatasetKey } from "./datadoe.coverage";

/**
 * Append-only archive of the UNTOUCHED raw DataDoe export payloads.
 *
 * The normalized cache (datadoe.cache.ts / datadoe.coverage.ts) stores parsed rows + provenance,
 * but it never keeps the original response body or a checksum, so the stored rows cannot be
 * independently verified against what DataDoe actually returned. This module closes that gap
 * WITHOUT touching the normalized cache: on every successful export it writes one immutable record
 * per export (keyed by exportId + datasetKey) containing the verbatim raw payload text, its SHA-256,
 * and full provenance (source, requested range, timestamps, request id). It is:
 *   - append-only  — an existing record is NEVER overwritten (each export id is written at most once);
 *   - best-effort  — it never throws into the export/cache flow, so archiving can't break a load;
 *   - local-only   — it only writes to disk under the cache dir, never sends the payload anywhere.
 *
 * It is deliberately a SEPARATE store (its own `raw/` subdirectory and schema) so the existing
 * cache file format and existing cached data are left completely unchanged.
 */

export const RAW_ARCHIVE_SCHEMA_VERSION = 1;

/** Base cache dir — same resolution as the normalized cache (honours DATADOE_CACHE_DIR). */
function baseCacheDir(): string {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

/** The raw archive lives in a dedicated subdirectory so it never mixes with normalized cache files. */
export function rawArchiveDir(): string {
  return path.join(baseCacheDir(), "raw");
}

/** Deterministic SHA-256 (hex) of the given text, computed over its UTF-8 bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface RawArchiveInput {
  exportId: string;
  sellerId: string;
  sourceName: string;
  sourceId: string | null;
  columns: string[];
  from: string | null; // requested range start (null when the export was not date-windowed)
  to: string | null; // requested range end
  status: string; // export status when captured (always "COMPLETED" on the success path)
  rowCount: number;
  requestId: string | null; // datadoe-api-request-id from the /raw response, when present
  rawPayload: string; // the UNTOUCHED response text, captured before JSON.parse
}

export interface RawArchiveRecord {
  archiveSchemaVersion: number;
  exportId: string;
  datasetKey: string; // ties this record back to the normalized .cov.json (same key derivation)
  sellerId: string;
  sourceName: string;
  sourceId: string | null;
  requestedFrom: string | null;
  requestedTo: string | null;
  columns: string[];
  status: string;
  rowCount: number;
  requestId: string | null;
  retrievedAt: string; // ISO 8601 archive-write time
  byteLength: number; // UTF-8 byte length of rawPayload
  sha256: string; // checksum of rawPayload
  rawPayload: string; // verbatim raw response text
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Archive file name for an export: `<exportId>__<datasetKey>.json` (both filesystem-safe). */
export function archiveFileName(exportId: string, datasetKey: string): string {
  return safeSegment(exportId) + "__" + safeSegment(datasetKey) + ".json";
}

/**
 * Persist one raw-export record. Append-only (never overwrites an existing record) and best-effort
 * (never throws — a failure/skip returns null and is logged, so the normalized flow is unaffected).
 * Returns the written file path, or null when skipped (already archived, empty payload, or on error).
 */
export async function archiveRawExport(input: RawArchiveInput): Promise<string | null> {
  try {
    if (typeof input.rawPayload !== "string" || input.rawPayload.length === 0) {
      return null; // nothing genuine to archive (e.g. a fake/mocked client that returns no raw text)
    }
    const datasetKey = computeDatasetKey({
      sellerId: input.sellerId,
      sourceName: input.sourceName,
      columns: input.columns,
    });
    const dir = rawArchiveDir();
    await fs.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, archiveFileName(input.exportId, datasetKey));

    // Append-only guarantee: if this export is already archived, do NOT overwrite it.
    try {
      await fs.access(finalPath);
      return null;
    } catch {
      // not present -> proceed to write
    }

    const record: RawArchiveRecord = {
      archiveSchemaVersion: RAW_ARCHIVE_SCHEMA_VERSION,
      exportId: input.exportId,
      datasetKey,
      sellerId: input.sellerId,
      sourceName: input.sourceName,
      sourceId: input.sourceId,
      requestedFrom: input.from,
      requestedTo: input.to,
      columns: input.columns,
      status: input.status,
      rowCount: input.rowCount,
      requestId: input.requestId,
      retrievedAt: new Date().toISOString(),
      byteLength: Buffer.byteLength(input.rawPayload, "utf8"),
      sha256: sha256Hex(input.rawPayload),
      rawPayload: input.rawPayload,
    };

    // Atomic write: O_EXCL temp then rename. The existence check above is the append-only guard;
    // the temp+rename ensures a crash mid-write can never leave a torn record at the final path.
    const tmp = finalPath + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, finalPath);
    return finalPath;
  } catch (err) {
    // Best-effort only: archiving must never break the export/cache flow. Local disk only — the
    // raw payload is never sent anywhere.
    // eslint-disable-next-line no-console
    console.warn(
      "[datadoe raw-archive] skipped:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
