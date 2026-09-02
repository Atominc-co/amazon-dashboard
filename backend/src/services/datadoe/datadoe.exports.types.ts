export interface ExportColumn {
  name: string;
  type: string;
  nullable: boolean;
  description: string | null;
}

export interface ExportSourceResponse {
  id: string;
  name: string;
  tableName: string;
  type: "SELLER_CENTRAL" | "VENDOR_CENTRAL" | "AMAZON_ADS";
  columns: ExportColumn[];
  description: string | null;
  containsPii: boolean;
  isPremium: boolean;
  enabled: boolean;
}

export interface ExportSourcesResponse {
  sources: ExportSourceResponse[];
  recommendedSources: ExportSourceResponse[];
}

export type ExportStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "ERROR" | "BLOCKED_NO_TOKENS";

export interface CreateExportRequest {
  sellerOrVendorIds: string[];
  sourceId: string;
  columns: string[];
  outputType: "JSON";
  sendToAllOrganizationMembers: false;
  skip?: number;
  limit?: number;
  from?: string;
  to?: string;
}

export interface ExportResponse {
  id: string;
  organizationId: string;
  sellerOrVendorIds: string[];
  status: ExportStatus;
  sourceId: string;
  sourceName: string;
}
