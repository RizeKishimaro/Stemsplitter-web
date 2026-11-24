

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],

  optimizeDeps: {
    exclude: [
      "onnxruntime-web",
      "@audio/neural-separate",
      "@audio/neural-runtime",
    ],
  },

  worker: {
    format: "es",
  },

  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    headers: isolationHeaders,
  },

  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: isolationHeaders,
  },
});


