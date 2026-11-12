# View-spec coverage check and worktree bootstrap

Read before adding a view or wdio spec, changing `scripts/check-view-spec-coverage.mjs`, or changing `scripts/bootstrap-worktree.ps1`.

- `pnpm run check:view-spec-coverage [files...]` (defaults to `git diff --name-only HEAD`) names every view/wdio spec that depends on a changed source file but was not itself changed - a contract change keeps vitest and tsc green while the spec driving it breaks. Links come from a spec's `await import("/...")`/relative imports, plus a `// asserts: <src path>[, <src path>]` header for specs that only drive the rendered UI (add one when writing such a spec).

- Worktree bootstrap: `powershell -File scripts/bootstrap-worktree.ps1` (run once right after `git worktree add`/`EnterWorktree`, before any build/verify - inits the `vendor/tauri_kit` submodule, runs `pnpm install`, seeds the gitignored `src/types/ipc.generated.ts`, and regenerates `android/`'s gitignored codegen output and NDK cross-compile env if `android/` exists; idempotent, cwd-independent). Not `pwsh`: PowerShell 7 is not installed here. Takes ~9s when it can copy `ipc.generated.ts` from an existing worktree, but several minutes on a fresh clone with no sibling to copy from, since it falls back to `cargo test --test export_types`.
