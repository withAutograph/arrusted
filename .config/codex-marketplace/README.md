# Project Vercel package

This project pins the unchanged official [Vercel plugin](https://github.com/vercel/vercel-plugin)
as an optional ignored checkout. Repository templates prohibit Git submodules;
the package is prepared only when a developer wants its agent guidance and is
not needed for application builds or template creation. The small marketplace
index uses its actual plugin name,
`vercel`; the upstream marketplace currently calls it `vercel-plugin`, which
Codex rejects. No vendor files are modified.

Pinned revision: `93a4de9d97d54ce3d6ea4951717873731ac8c3ec`.
The newer `358400a` revision has invalid YAML in its AI Gateway skill;
this preceding revision passes skill discovery without that error.

For a new checkout, initialize the package and register the local marketplace:

```sh
mise run repository:prepare-vercel-plugin
codex plugin marketplace add .config/codex-marketplace
codex plugin add vercel@vercel-project
```

The install command enables the package in your user Codex configuration.
To scope it to this project, set `[plugins."vercel@vercel-project"]` to
`enabled = false` in your user config and enable it in a project-level Codex
config instead. Restart discovery after changing selections.
