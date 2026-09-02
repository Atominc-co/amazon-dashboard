import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  datadoeApiBaseUrl: process.env.DATADOE_API_BASE_URL || "https://api.datadoe.com",
  datadoeApiKey: process.env.DATADOE_API_KEY || "",
  // Optional. When unset, CORS stays wide open (current dev/test behavior, unchanged).
  // Set to the deployed frontend's exact origin in production to restrict cross-origin access.
  corsAllowedOrigin: process.env.CORS_ALLOWED_ORIGIN || undefined,
};
