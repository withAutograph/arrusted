---
name: ship-change
description: Save and publish work safely with a branch, small commits and a draft PR the builder can understand. Use before the first edit of any change, whenever someone says save, commit, push, publish, merge or "make it live", and whenever Git is in a confusing state.
---

# Ship a change

You handle Git so the builder doesn't have to. Use plain words: "a separate copy
of the change", "a proposal you can review", "put it into the main version".

## 1. Before editing

1. Check `git status`, the current branch and the remote.
2. If there are changes you didn't make, stop. Say what they are and ask whether
   to keep, include or set them aside. Never discard them.
3. Update `main` with `git pull --ff-only`. If that refuses, explain; don't force it.
4. Start a short-named branch: `git switch -c add-deal-source`. One topic each.

If there is no GitHub repo yet, offer to create a **private** one with their own
`gh` login. Confirm the owner and name first.

## 2. While working

- Commit at each working point with `HK=true git commit`, naming files explicitly.
  Never `git add -A` without reading the list.
- Never commit `.env*`, restore points, data exports, customer CSVs or
  `app/.generated`. If a secret was ever committed, stop: it must be replaced, not
  just removed, and tell them.
- Don't mix unrelated fixes into the change. Mention them instead.

## 3. Propose it

1. Run `bun run compile`, `bun run check` and the tests for what changed. For schema
   changes, also run `bun run migrate:rehearse` on a disposable copy.
2. Push the branch and open a **draft** PR (`gh pr create --draft`) with:
   - **What changes for people using the app**, in one or two plain sentences.
   - **What happens to the data:** tables and fields added, renamed, archived or made
     required, and how many rows are affected. Say "No data changes" if so. Say
     plainly that archiving can't be reversed by adding the field back.
   - **How to try it**, and a screenshot for visible changes.
   - **What was checked**, and anything that wasn't.
   - **How to undo it.**
3. Give them the link and that same summary in chat. Ask: "Shall I put this into the
   main version?" Wait for a yes about **this** PR.

## 4. After a yes

Wait for checks to pass, mark the PR ready and merge it. Never merge on red, with
unresolved review comments, or with an admin override. If someone else must
approve, ask them. Then update local `main`.

A merge is not a deploy. Ask separately, then follow the `deploy` skill.

## Protecting `main`

Once per repo, offer to turn on GitHub branch protection: require a PR, require
checks, block force pushes and deletion. Explain that it stops accidents by anyone,
including you. Ask before changing settings. If their GitHub plan doesn't allow it
for private repos, say so and carry on.

## When something looks wrong

Conflicts, a detached HEAD, work on `main`, or a diverged branch: stop, make a
backup branch (`git branch backup/<date>-<topic>`), explain, then fix it without
discarding anything. Moving stray uncommitted work off `main` is just
`git switch -c <name>`.
