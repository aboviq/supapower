# Contributing to Supapower

Thanks for taking the time. This document covers the day to day mechanics of working in this
repository.

## Setup

Install [Bun](https://bun.com/) 1.4 or later (preferably using [Mise](https://mise.jdx.dev)), then:

```bash
bun install
```

Installing runs `husky`, which registers the pre-commit hook. The hook runs lint-staged, which lints
and formats the files you staged. If a file cannot be fixed automatically the commit is rejected.

## Repository layout

```
packages/           publishable packages, one directory each
.changeset/         pending release notes
.github/workflows/  continuous integration and release
```

Every package is ESM only. Relative imports carry a `.js` extension so the emitted JavaScript runs
unchanged in Node.js.

## Before you open a pull request

```bash
bun run check
```

That runs lint, the format check, the typechecker and the tests, which is exactly what continuous
integration runs.

## Tests

Tests live next to the code they cover as `*.test.ts` and use the Bun test runner.

```bash
bun test
bun run test:coverage
```

## Describing a change

Any change that affects a published package needs a changeset:

```bash
bun run changeset
```

Pick the packages you touched, pick a bump type and write a sentence a user of the package would
understand. Commit the generated file in `.changeset` along with your code.

Bump types follow semantic versioning. While a package is below `1.0.0`, breaking changes are minor
bumps.

## Releasing

Merging to `main` makes the release workflow open a pull request titled "chore: version packages".
That pull request applies the pending changesets, bumps versions and updates changelogs. Merging it
publishes the packages to npm.

Publishing needs an `NPM_TOKEN` repository secret with publish rights for the `@supapower` scope.

## Adding a package

1. Create `packages/<name>` with a `package.json` named `@supapower/<name>`.
2. Copy `tsconfig.json` and `tsconfig.build.json` from `packages/core`.
3. Give it `build`, `typecheck` and `clean` scripts so the root scripts pick it up.
4. Copy `LICENSE` and `NOTICE` into the package and list them in `files`.

Depend on a sibling package with the workspace protocol:

```json
{
  "dependencies": {
    "@supapower/core": "workspace:*"
  }
}
```

Depend on common packages with the catalog protocol:

```json
{
  "devDependencies": {
    "typescript": "catalog:"
  }
}
```

(common package versions are specified in the root package.json's `"catalog"` dependencies)

## Code style

Oxfmt owns formatting, so do not argue with it. Oxlint owns the rules. Both are configured at the
repository root in `.oxfmtrc.json` and `.oxlintrc.json`, and both run on staged files at commit
time.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
