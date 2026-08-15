// Pushes the Drizzle schema to a dedicated test.db file, kept separate
// from your dev flexfit.db so running tests never touches real dev data.
// Runs automatically before `pnpm test` via the "pretest" script.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
  env: { ...process.env, DB_FILE: "file:test.db" },
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 0);
