import express, { Application } from "express";
import cors from "cors";
import { env } from "./config/env";
import healthRoutes from "./routes/health.routes";
import sellersRoutes from "./routes/sellers.routes";

const app: Application = express();

// env.corsAllowedOrigin is unset unless CORS_ALLOWED_ORIGIN is configured, so this is
// `cors()` (wildcard) by default — identical to prior behavior — until a production
// origin is explicitly supplied via environment variable.
app.use(cors(env.corsAllowedOrigin ? { origin: env.corsAllowedOrigin } : undefined));
app.use(express.json());

app.use("/api", healthRoutes);
app.use("/api", sellersRoutes);

export default app;
