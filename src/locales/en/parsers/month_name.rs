# Pinned upstream: chrono-node

| Field | Value |
|---|---|
| Project | [wanasit/chrono](https://github.com/wanasit/chrono) (npm `chrono-node`) |
| Version | `v2.10.3` |
| Commit | `d4fe7e39015c818b271d74789fb96f74777421d0` |
| Licence | MIT (`LICENSE.txt`, also reproduced in the root `NOTICE`) |

## What is here

Copied unmodified from the commit above:

- `src/`, `test/`
- `LICENSE.txt`, `README.md`
- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `tsconfig.build.esm.json`

Not copied: `.github/`, `AGENTS.md`, `benchmark/`, `examples/`, `.travis.yml`, `.editorconfig`, `.gitignore`.

## Rules

- **Read-only.** Never edit files here. This directory is human tier and protected from agents.
- Everything derived from it records the commit SHA: golden tests, contracts (`source_sha`) and the comparison harness.

## Bumping the pin

Done by a reviewed PR only:

1. Re-copy the same file list from the new tag and update the table above.
2. Regenerate `tests/golden/` with the harness.
3. Re-run the seed script, so contracts pick up the new `source_sha`.
