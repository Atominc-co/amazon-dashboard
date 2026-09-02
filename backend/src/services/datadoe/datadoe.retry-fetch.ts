const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin wrapper around fetch() for authenticated DataDoe API calls only — never the signed
 * storage-file redirect target in fetchExportRawData, which carries no key and isn't subject
 * to DataDoe's rate limit. DataDoe enforces an org-wide ~2 req/s limit; every caller here
 * already awaits its DataDoe calls strictly sequentially (no concurrency anywhere), but a
 * single endpoint can still burst several calls (sources, create, raw — doubled for endpoints
 * that fetch a current + previous period) within well under a second when exports complete
 * quickly, which is enough to exceed that budget on its own. Retrying a 429 specifically —
 * honoring DataDoe's own Retry-After header when present, capped at MAX_RETRIES — resolves
 * that burst transparently without adding any delay to the (overwhelmingly common) non-429
 * path. A 429 that persists past MAX_RETRIES is returned exactly as fetch() would return it,
 * so existing DataDoeApiError handling in every caller is unchanged.
 */
export async function datadoeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt >= MAX_RETRIES) {
      return response;
    }
    attempt += 1;
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const backoffMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : DEFAULT_BACKOFF_MS * 2 ** (attempt - 1);
    await sleep(backoffMs);
  }
}
