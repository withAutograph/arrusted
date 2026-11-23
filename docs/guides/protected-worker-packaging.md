# Protected worker packaging

Protected Auth, Auth proposal, Neon resource bootstrap, and generated-app
installer/access packaging share the repository-owned parser asset plugin in
`.config/mise/scripts/repository/protected-parser-assets.mjs`. It embeds the
installed PostgreSQL parser's actual WASM bytes through its `wasmBinary` input,
so these workers do not require a source checkout or parser asset on disk.
Auth packaging retains its owned SQL asset plugin. Auth proposal packaging
retains its Bun 1.3.14 compiler requirement.

Package the generated-app installer/access worker with an output path outside
the checkout:

```sh
mise run repository:build-protected-generated-app-worker -- /tmp/generated-app-protected-worker bun-linux-x64
```

The explicit target selects Linux x64; the packaging script also defaults to
`bun-linux-x64`. A host target may be supplied for an isolated, database-free
parser probe. Protected workflow callers invoke the owning packaging scripts
with structured arguments and record the source revision, compiler, target,
output SHA256, and actual bytes. Auth and resource bundle callers compile their
emitted JavaScript with an explicit target after the owned asset plugin runs.

Cross-compilation and an ELF header establish binary packaging only. Linux
runtime execution, authenticated installer behavior, and provider acceptance
require separate evidence from the authorized runtime owner.
