import "dotenv/config";
import app from "./app";

const PORT = Number(process.env.PORT ?? 4000);

const server = app.listen(PORT, () => {
  console.log(`edusphere-backend listening on port ${PORT}`);
});

async function shutdown() {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
