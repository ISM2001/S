import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./env";

/** Apply pending migrations (non-destructive) to the dedicated test database once per run. Tests truncate their own tables. */
export default function setup() {
  execSync("pnpm exec prisma migrate deploy", {
    cwd: new URL("../../../packages/db", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
}
