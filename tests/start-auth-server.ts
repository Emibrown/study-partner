import { spawn } from "node:child_process";
import path from "node:path";
import { voiceConfig } from "./mock-elevenlabs.mjs";
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--port", "3100"],
  {
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_BUILD_DIR: ".next-auth-test",
      NODE_OPTIONS: `--import=${path.resolve("tests/mock-google.mjs")}`,
      DATABASE_URL:
        "postgresql://study_test@127.0.0.1:55439/study_partner_test",
      BETTER_AUTH_SECRET: "isolated-playwright-test-secret-not-for-deployment",
      BETTER_AUTH_URL: "http://localhost:3100",
      GOOGLE_CLIENT_ID: "test",
      GOOGLE_CLIENT_SECRET: "test",
      BACKBOARD_API_KEY: "isolated-backboard-test-key",
      ...voiceConfig,
      VOICE_TEST_SDK: "isolated",
      R2_ENDPOINT: "",
      R2_BUCKET: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
