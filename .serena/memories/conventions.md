# Conventions

- TypeScript strict; production code must not use `as any`.
- Reuse shared `tests/mocks/log.ts` and `tests/mocks/debug.ts` for side-effectful logging modules; do not mock pure modules.
- Feature flags use `import { feature } from 'bun:bundle'`; only direct `if`/ternary conditions.
- Biome: non-TSX 80 columns/as-needed semicolons; TSX 120 columns/required semicolons.
- Preserve user worktree changes; use minimal shared-root fix, not per-caller patches.