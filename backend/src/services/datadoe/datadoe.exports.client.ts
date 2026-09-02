import { env } from "../../config/env";
import { DataDoeApiError } from "./datadoe.client";
import { datadoeFetch } from "./datadoe.retry-fetch";
import {
  CreateExportRequest,
  ExportResponse,
  ExportSourcesResponse,
} from "./datadoe.exports.types";

const EXPORT_SOURCES_PATH = "/api/v1/exports/sources";
const EXPORTS_PATH = "/api/v1/exports";

function requireApiKey(): string {
  if (!env.datadoeApiKey) {
    throw new Error("DATADOE_API_KEY is not configured");
  }
  return env.datadoeApiKey;
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (body && typeof body.message === "string") {
      return body.message;
    }
  } catch {
    // Response body was not JSON or was empty; fall back to the generic message below.
  }
  return `DataDoe API request failed with status ${response.status}`;
}

export async function getExportSources(sellerOrVendorIds: string[]): Promise<ExportSourcesResponse> {
  const apiKey = requireApiKey();

  const url = new URL(EXPORT_SOURCES_PATH, env.datadoeApiBaseUrl);
  for (const id of sellerOrVendorIds) {
    url.searchParams.append("sellerOrVendorIds", id);
  }

  const response = await datadoeFetch(url, {
    method: "GET",
    headers: { "datadoe-api-key": apiKey },
  });

  const requestId = response.headers.get("datadoe-api-request-id");

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new DataDoeApiError(response.status, message, requestId);
  }

  return (await response.json()) as ExportSourcesResponse;
}

export async function createExport(body: CreateExportRequest): Promise<ExportResponse> {
  const apiKey = requireApiKey();

  const response = await datadoeFetch(new URL(EXPORTS_PATH, env.datadoeApiBaseUrl), {
    method: "POST",
    headers: {
      "datadoe-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const requestId = response.headers.get("datadoe-api-request-id");

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new DataDoeApiError(response.status, message, requestId);
  }

  return (await response.json()) as ExportResponse;
}

export async function getExportStatus(exportId: string): Promise<ExportResponse> {
  const apiKey = requireApiKey();

  const response = await datadoeFetch(
    new URL(`${EXPORTS_PATH}/${encodeURIComponent(exportId)}`, env.datadoeApiBaseUrl),
    {
      method: "GET",
      headers: { "datadoe-api-key": apiKey },
    }
  );

  const requestId = response.headers.get("datadoe-api-request-id");

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new DataDoeApiError(response.status, message, requestId);
  }

  return (await response.json()) as ExportResponse;
}

export type ExportRawResult<T> =
  | { state: "ready"; rows: T[]; raw: string; requestId: string | null }
  | { state: "pending" }
  | { state: "not_found" };

/**
 * Fetches the completed export's raw data. The DataDoe API responds with a 302
 * redirect to a signed file URL; that follow-up request is made deliberately
 * WITHOUT the datadoe-api-key header, so the secret is never sent to the
 * third-party storage host behind the redirect.
 */
export async function fetchExportRawData<T = unknown>(exportId: string): Promise<ExportRawResult<T>> {
  const apiKey = requireApiKey();

  const response = await datadoeFetch(
    new URL(`${EXPORTS_PATH}/${encodeURIComponent(exportId)}/raw`, env.datadoeApiBaseUrl),
    {
      method: "GET",
      headers: { "datadoe-api-key": apiKey },
      redirect: "manual",
    }
  );

  if (response.status === 204) {
    return { state: "pending" };
  }

  if (response.status === 404) {
    return { state: "not_found" };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("DataDoe raw export redirect had no Location header");
    }
    // The DataDoe /raw response (this redirect) is where a request id is available; the signed
    // storage file it points to is a third-party host and carries none.
    const requestId = response.headers.get("datadoe-api-request-id");

    const fileResponse = await fetch(location, { method: "GET" });
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch DataDoe export file (status ${fileResponse.status})`);
    }

    // Capture the UNTOUCHED raw payload text BEFORE JSON.parse so it can be archived verbatim and
    // checksummed. Parsing the captured text here (instead of fileResponse.json()) is equivalent —
    // a malformed body throws exactly as .json() would — while also yielding the exact bytes the
    // raw archive needs. The parsed rows returned to the cache flow are unchanged.
    const rawText = await fileResponse.text();
    const rows = JSON.parse(rawText) as T[];
    return { state: "ready", rows, raw: rawText, requestId };
  }

  const message = await extractErrorMessage(response);
  throw new DataDoeApiError(response.status, message, response.headers.get("datadoe-api-request-id"));
}
