# Scoped architecture rules

This directory contains declarative architecture checks for violations that
are local AST shapes: forbidden imports and direct calls. The exact-pinned CLI
is the root `@ast-grep/cli` dev dependency.

Run the positive and negative rule fixtures:

```bash
mise run test:ast-grep
```

Scan the supported repository source roots:

```bash
mise run check:ast-grep
```

The Konsistent/static validation lane runs both commands. Rule tests use ast-grep's `valid` and
`invalid` cases: an invalid case passes only when its forbidden syntax is
reported.

Keep this layer narrow. Use `files` and `ignores` to encode ownership at the
smallest source boundary, add TypeScript, TSX, and JavaScript variants when the
runtime supports those extensions, and add root/subpath fixtures for package
imports. Cross-file resolution, semantic vocabulary, Cargo dependency policy,
generated contracts, and runtime authority checks stay with their owning
mechanism.

The provider/persistence rule scopes vendor provider I/O to
`apps/vendor/integrations/ampersand/provider-adapters/**`. Those adapters may
import only adapter-local modules and Node transport built-ins. All upward or package
imports fail, including re-export wrappers around generated clients,
app-normalized constructors, trusted Rust bridges, kernel contracts, and
database packages. Known diagnostic receivers (including aliases,
destructuring, computed members, and stdout/stderr writes) fail throughout
provider adapters, provider config, and nested raw transport/envelope owners;
ordinary data properties such as `response.error` remain valid. Persistence accepts the separate branded app-normalized
type, so provider ownership no longer depends on table-name vocabulary;
singular or plural identifiers do not affect the boundary. Existing broader
scanner tripwires remain active for compiler and package invariants.
