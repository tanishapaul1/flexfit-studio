import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    env: {
      DB_FILE: "file:test.db",
    },
    // Bookings/reschedule logic mutates shared tables (credits, capacity)
    // so tests run one at a time within a file to avoid interfering with
    // each other; each test still gets a clean slate via resetDb().
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
