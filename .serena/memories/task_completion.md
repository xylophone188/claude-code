# Task completion

- For every source change: run targeted `bun test <file>` plus `bun run typecheck`.
- Run `bun run lint` when scope warrants; full gate is `bun run test:all`.
- Check Git diff/status before handoff; do not claim completion from a narrow check that misses changed behavior.