// Offline/static tests for the raw DataDoe archive (src/services/datadoe/datadoe.raw-archive.ts,
// compiled to dist). NO network, NO DataDoe, NO Sync, NO Export — this exercises ONLY the local
// archive writer against synthetic/mocked payloads in a throwaway temp cache dir. Proves: SHA-256
// determinism, correct metadata, verbatim payload preservation, append-only (never overwrite), the
// dedicated raw/ location, and that the existing normalized cache format is untouched.
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const TMP = path.join(os.tmpdir(), "dd-rawarchive-test-" + process.pid);
process.env.DATADOE_CACHE_DIR = TMP;
// Backstop: if any code path unexpectedly tried DataDoe, this host refuses connections.
process.env.DATADOE_API_BASE_URL = "http://127.0.0.1:59998";
process.env.DATADOE_API_KEY = "dummy_test_key_not_real";

const archive = require("../dist/services/datadoe/datadoe.raw-archive");
const coverage = require("../dist/services/datadoe/datadoe.coverage");
const cache = require("../dist/services/datadoe/datadoe.cache");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log("  PASS: " + msg); } else { fail++; console.log("  FAIL: " + msg); } }

const SELLER = "seller-xyz";
const SOURCE = "Sales & Traffic by ASIN & Date";
const COLUMNS = ["date", "child_asin", "total_sales"];
// Realistic verbatim payload text (as DataDoe's export file would arrive, before JSON.parse).
const RAW = '[{"date":"2026-07-20","child_asin":"B0TEST00001","total_sales":100.93},' +
            '{"date":"2026-07-21","child_asin":"B0TEST00001","total_sales":40.0}]';

(async () => {
  console.log("RAW ARCHIVE TESTS (offline, no DataDoe)\n");

  // --- SHA-256 determinism + correctness vs Node crypto reference ---
  const h1 = archive.sha256Hex(RAW);
  const h2 = archive.sha256Hex(RAW);
  const ref = crypto.createHash("sha256").update(RAW, "utf8").digest("hex");
  assert(h1 === h2, "sha256Hex is deterministic (same input -> same hash)");
  assert(h1 === ref, "sha256Hex matches Node crypto reference (" + ref.slice(0, 12) + "…)");
  assert(archive.sha256Hex("a") !== archive.sha256Hex("b"), "different inputs -> different hashes");

  // --- archiveRawExport writes a correct record in raw/ ---
  const p1 = await archive.archiveRawExport({
    exportId: "exp-0001", sellerId: SELLER, sourceName: SOURCE, sourceId: "src-abc",
    columns: COLUMNS, from: "2026-07-20", to: "2026-08-24", status: "COMPLETED",
    rowCount: 2, requestId: "req-111", rawPayload: RAW,
  });
  assert(typeof p1 === "string" && fs.existsSync(p1), "archiveRawExport wrote a record file");
  assert(path.dirname(p1) === path.join(TMP, "raw"), "record written under the dedicated raw/ dir");

  const datasetKey = coverage.computeDatasetKey({ sellerId: SELLER, sourceName: SOURCE, columns: COLUMNS });
  assert(path.basename(p1) === "exp-0001__" + datasetKey + ".json",
    "filename is <exportId>__<datasetKey>.json");

  const rec = JSON.parse(fs.readFileSync(p1, "utf8"));
  assert(rec.archiveSchemaVersion === 1, "archiveSchemaVersion = 1");
  assert(rec.exportId === "exp-0001", "exportId stored");
  assert(rec.datasetKey === datasetKey, "datasetKey matches computeDatasetKey (ties to .cov.json)");
  assert(rec.sourceId === "src-abc" && rec.sourceName === SOURCE, "source id/name stored");
  assert(rec.sellerId === SELLER, "sellerId stored");
  assert(rec.requestedFrom === "2026-07-20" && rec.requestedTo === "2026-08-24", "requested From/To stored");
  assert(JSON.stringify(rec.columns) === JSON.stringify(COLUMNS), "requested columns stored");
  assert(rec.status === "COMPLETED" && rec.rowCount === 2, "status + rowCount stored");
  assert(rec.requestId === "req-111", "requestId stored");
  assert(typeof rec.retrievedAt === "string" && !isNaN(Date.parse(rec.retrievedAt)), "retrievedAt is a valid ISO timestamp");
  assert(rec.rawPayload === RAW, "rawPayload preserved VERBATIM (byte-for-byte)");
  assert(rec.byteLength === Buffer.byteLength(RAW, "utf8"), "byteLength correct");
  assert(rec.sha256 === ref, "stored sha256 matches the raw payload");
  // Independent re-hash of what was stored proves integrity end-to-end.
  assert(crypto.createHash("sha256").update(rec.rawPayload, "utf8").digest("hex") === rec.sha256,
    "re-hashing stored rawPayload reproduces stored sha256");

  // --- append-only: re-archiving the SAME export id must NOT overwrite ---
  const before = fs.readFileSync(p1, "utf8");
  const mtimeBefore = fs.statSync(p1).mtimeMs;
  const p2 = await archive.archiveRawExport({
    exportId: "exp-0001", sellerId: SELLER, sourceName: SOURCE, sourceId: "src-abc",
    columns: COLUMNS, from: "2026-07-20", to: "2026-08-24", status: "COMPLETED",
    rowCount: 2, requestId: "req-DIFFERENT", rawPayload: RAW + "TAMPERED",
  });
  const after = fs.readFileSync(p1, "utf8");
  assert(p2 === null, "second archive of same exportId returns null (skipped)");
  assert(before === after, "existing record NOT overwritten (append-only)");
  assert(fs.statSync(p1).mtimeMs === mtimeBefore, "record file mtime unchanged (never rewritten)");

  // --- distinct export id -> new appended record; both coexist ---
  const p3 = await archive.archiveRawExport({
    exportId: "exp-0002", sellerId: SELLER, sourceName: SOURCE, sourceId: "src-abc",
    columns: COLUMNS, from: "2026-08-01", to: "2026-08-05", status: "COMPLETED",
    rowCount: 1, requestId: null, rawPayload: '[{"date":"2026-08-01"}]',
  });
  assert(typeof p3 === "string" && fs.existsSync(p3) && fs.existsSync(p1),
    "distinct exportId appends a new record; prior record still present");
  const rawDirCount = fs.readdirSync(path.join(TMP, "raw")).filter(f => f.endsWith(".json")).length;
  assert(rawDirCount === 2, "raw/ now holds exactly 2 records (append-only accumulation)");

  // --- empty / non-string payload -> skipped, no file, no throw (protects existing tests/mocks) ---
  const p4 = await archive.archiveRawExport({
    exportId: "exp-empty", sellerId: SELLER, sourceName: SOURCE, sourceId: "src-abc",
    columns: COLUMNS, from: null, to: null, status: "COMPLETED", rowCount: 0,
    requestId: null, rawPayload: "",
  });
  const p5 = await archive.archiveRawExport({
    exportId: "exp-nostr", sellerId: SELLER, sourceName: SOURCE, sourceId: "src-abc",
    columns: COLUMNS, from: null, to: null, status: "COMPLETED", rowCount: 0,
    requestId: null, rawPayload: undefined,
  });
  assert(p4 === null && p5 === null, "empty/undefined payload -> skipped (returns null, no throw)");
  assert(fs.readdirSync(path.join(TMP, "raw")).filter(f => f.endsWith(".json")).length === 2,
    "no record file created for empty/undefined payloads");

  // --- existing normalized cache format is untouched by archiving ---
  // Write a normalized coverage entry the SAME way the app does, archive alongside, and confirm the
  // .cov.json is byte-identical before/after and the archive lives ONLY under raw/.
  const key = coverage.computeDatasetKey({ sellerId: SELLER, sourceName: SOURCE, columns: undefined });
  const entry = coverage.newCoverageEntry({
    datasetKey: key, sellerId: SELLER, sourceName: SOURCE, columns: ["date"], source: null,
  });
  entry.rows = [{ date: "2026-07-20", total_sales: 1 }];
  entry.intervals = [{ from: "2026-07-20", to: "2026-07-20" }];
  await coverage.writeCoverage(key, entry);
  const covPath = path.join(TMP, key + ".cov.json");
  const covBefore = fs.readFileSync(covPath, "utf8");
  await archive.archiveRawExport({
    exportId: "exp-cov", sellerId: SELLER, sourceName: SOURCE, sourceId: "src-abc",
    columns: ["date"], from: "2026-07-20", to: "2026-07-20", status: "COMPLETED",
    rowCount: 1, requestId: null, rawPayload: '[{"date":"2026-07-20","total_sales":1}]',
  });
  const covAfter = fs.readFileSync(covPath, "utf8");
  assert(covBefore === covAfter, "existing .cov.json is byte-identical after archiving (cache untouched)");
  const covFieldsOk = !("rawPayload" in JSON.parse(covAfter)) && !("sha256" in JSON.parse(covAfter));
  assert(covFieldsOk, "normalized coverage schema unchanged (no rawPayload/sha256 leaked into it)");

  console.log("\n==== " + pass + " passed, " + fail + " failed ====");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("FATAL: " + (e && e.stack || e)); process.exit(1); });
