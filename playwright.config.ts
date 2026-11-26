import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 8 * 60 * 1000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: "list",
  use: {
    // Match the backend's default CORS origin in local development.
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{
    name: "firefox",
    use: { ...devices["Desktop Firefox"] },
  }],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
