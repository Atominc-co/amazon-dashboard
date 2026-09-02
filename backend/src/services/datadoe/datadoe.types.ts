export interface SellersAndVendorsConnection {
  id: string | null;
  name: string | null;
  rowCount: number | null;
  initialLoadComplete: boolean | null;
}

export interface SellersAndVendorsItem {
  id: string;
  name: string;
  rowCount: number;
  marketplaceId: string | null;
  marketplaceCountryCode: string | null;
  marketplaceCountryName: string | null;
  sellerCentralConnection: SellersAndVendorsConnection | null;
  vendorCentralConnection: SellersAndVendorsConnection | null;
  amazonAdsConnection: SellersAndVendorsConnection | null;
}

export interface PaginatedMeta {
  currentPageSize: number;
  pageSize: number;
  currentPage: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  results: number;
  totalResults: number;
}

export interface SellersAndVendorsResponse {
  data: SellersAndVendorsItem[];
  meta: PaginatedMeta;
  params?: Record<string, unknown>;
}
