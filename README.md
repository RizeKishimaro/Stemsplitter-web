# DubPad

DubPad is a browser-based stem separation, beat analysis, and music remix workstation. Audio import, analysis, and SCNet stem separation run locally in the browser through Web Workers and ONNX Runtime Web.

## Development

Requirements: Node.js and pnpm.

```bash
pnpm install
pnpm dev
```

Run the TypeScript check and production build with:

```bash
pnpm exec tsc --noEmit
pnpm build
```

The Rust API is maintained in the sibling `soniclab-backend` project. Its existing package identifier and API paths remain unchanged while user-facing documentation and API metadata use DubPad branding.

To connect Rust HTDemucs jobs, set `VITE_RUST_API_URL` to the backend origin (for example `http://localhost:8787`). With an audio file loaded, choose Mix first or Drums first and the meter, then select **Separate with HTDemucs**. Completed four-stem bars are fetched over HTTP as WebSocket `chunk.completed` events arrive and added to the arrangement at the exact source sample range. The final beat grid is imported from the persisted Beat This result. The existing browser-local separation workflow remains available separately.

## Browser audio pipeline

- Music analysis and section processing run in workers.
- Stem separation uses SCNet with ONNX Runtime Web in the browser.
- The four arrangement tracks are drums, bass, other, and vocals.
- Original sample positions are retained as the timing authority for arrangement sections.

This repository is a Vite + React + TypeScript application. Its npm package identifier remains `soniclab-web` for compatibility.
