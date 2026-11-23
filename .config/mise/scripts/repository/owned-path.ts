import { lstatSync } from "node:fs";
import path from "node:path";

/** Allow a workspace-root alias, but never follow links in repository-owned descendants. */
export function assertOwnedPath(root: string, relativePath: string): void {
  const repositoryRoot = path.resolve(root);
  const destination = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, destination);
  if (
    path.isAbsolute(relativePath) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${relativePath} must be inside the repository`);
  }

  let candidate = repositoryRoot;
  for (const component of relative.split(path.sep)) {
    candidate = path.join(candidate, component);
    const entry = lstatSync(candidate, { throwIfNoEntry: false });
    if (entry === undefined) return;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${relativePath} traverses symbolic link ${path.relative(repositoryRoot, candidate)}`,
      );
    }
  }
}
