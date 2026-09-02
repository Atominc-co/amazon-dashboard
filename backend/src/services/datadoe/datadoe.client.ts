import { env } from "../../config/env";
import { datadoeFetch } from "./datadoe.retry-fetch";
import { SellersAndVendorsResponse } from "./datadoe.types";

const SELLERS_AND_VENDORS_PATH = "/api/v1/util/sellers-and-vendors";

export class DataDoeApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, message: string, requestId: string | null) {
    super(message);
    this.name = "DataDoeApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

export interface GetSellersAndVendorsParams {
  page?: number;
  pageSize?: number;
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

export async function getSellersAndVendors(
  params: GetSellersAndVendorsParams = {}
): Promise<SellersAndVendorsResponse> {
  if (!env.datadoeApiKey) {
    throw new Error("DATADOE_API_KEY is not configured");
  }

  const url = new URL(SELLERS_AND_VENDORS_PATH, env.datadoeApiBaseUrl);
  if (params.page !== undefined) {
    url.searchParams.set("page", String(params.page));
  }
  if (params.pageSize !== undefined) {
    url.searchParams.set("pageSize", String(params.pageSize));
  }

  const response = await datadoeFetch(url, {
    method: "GET",
    headers: {
      "datadoe-api-key": env.datadoeApiKey,
    },
  });

  const requestId = response.headers.get("datadoe-api-request-id");

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new DataDoeApiError(response.status, message, requestId);
  }

  return (await response.json()) as SellersAndVendorsResponse;
}
