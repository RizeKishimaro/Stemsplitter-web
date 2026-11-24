import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["master-sections.spec.ts", "*.unit.spec.ts"],
  fullyParallel: false,
  reporter: "list",
});
