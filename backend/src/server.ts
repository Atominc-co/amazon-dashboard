import app from "./app";
import { env } from "./config/env";

app.listen(env.port, () => {
  console.log(`Backend server running on port ${env.port} [${env.nodeEnv}]`);
});
