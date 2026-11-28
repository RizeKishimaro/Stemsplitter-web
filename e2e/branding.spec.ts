import { expect, test } from "@playwright/test";

test("DubPad page title and PWA manifest use the new product name", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("DubPad — Stem Remix Workstation");
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute("content", "DubPad");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "DubPad is a browser-based stem separation, beat analysis, and music remix workstation.",
  );

  const manifestResponse = await page.request.get(
    new URL("/manifest.webmanifest", page.url()).toString(),
  );
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json() as { name: string; short_name: string };
  expect(manifest.name).toBe("DubPad — Stem Remix Workstation");
  expect(manifest.short_name).toBe("DubPad");
});
