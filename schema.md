# Claude Code Wiki Schema

This wiki indexes the OpenAI Codex CLI (`claude-code`) codebase.

## Page types

- `module` — A TypeScript source module, build script, or Rust CLI entry point.
- `component` — A UI component or reusable frontend element.
- `api` — An OpenAI-compatible API endpoint, request handler, or protocol shim.
- `concept` — An architecture pattern, design decision, or subsystem.
- `task` — A build, test, CI, or development workflow.

## Linking rules

- Each code page must cite its source file path in frontmatter.
- Cross-references use `[[Page Title]]` wiki-style links.
