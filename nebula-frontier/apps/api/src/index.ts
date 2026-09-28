/**
 * API process entry: build the app, start background jobs, listen on API_PORT, graceful shutdown.
 */
import { buildApp } from "./app.js";
import { startJobs } from "./jobs/index.js";

const app = await buildApp();
const stopJobs = startJobs(app);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopJobs();
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: app.env.API_PORT, host: app.env.API_HOST });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
