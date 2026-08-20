# Tech stack

- Bun runtime/workspaces; ESM TypeScript/TSX, React JSX transform, strict TypeScript.
- Build: `build.ts` calls `Bun.build()` with code splitting; dev: `scripts/dev.ts` injects feature defines.
- Tests: `bun:test`; formatting/lint: Biome.
- `src/*` alias resolves to `./src/*`; `bun:bundle` `feature()` calls must remain direct conditions.