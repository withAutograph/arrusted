# Interaction Footguns

Known UX / interaction patterns where the current implementation has a defensible answer for V0 but a real product question lurks. Each entry has multiple defensible product responses; resolving them requires a UX call (often after watching a real user hit the seam), not just a code change. Distinct from `known-footguns.md` which is *substrate / contract* hardening triggers.

Add to this file when you find an interaction question the system handles in some way but where alternative handling is equally defensible. Keep this file lean: each entry is a real surface where a product debate would change behavior, NOT just a missing feature or a polish backlog.

---

## as-of change while edits are pending

**Surface:** `apps/hc/frontend/src/pages/PositionsPage.tsx` — the AsOfDatePill in the utility toolbar lets the user pick a new as-of date freely. Each pending buffer entry snapshots its `effectiveStart` at edit time (per `EditMeta` in `packages/engines/edit-buffer/index.ts`), so changing as-of WITHOUT first saving leaves dirty rows anchored to the *previous* as-of while the visible records reload at the *new* as-of.

**Current behavior:** as-of change is non-blocking. The buffer's snapshot semantics keep edits correctly anchored on the wire (Save still applies them at the original effective_start). The UI does not surface the asymmetry: the user sees their dirty rows alongside records loaded at a different as-of, with no signal that the edits will land at a different date than they're now viewing.

**Defensible alternatives:**
- **Block-or-confirm**: as-of change while dirty triggers a confirm dialog ("You have N pending edits at <prior date>. Switching as-of will keep those edits anchored to <prior date>. Continue?").
- **Display the anchor**: dirty rows render with a visible "→ <effective date>" badge so the asymmetry is legible without requiring user action.
- **Force commit-or-discard**: as-of change is disabled while dirty; user must Save or Discard first.

**Why deferred:** none of these is obviously right without product evidence. Real users may want to backdate edits while looking at current state (the current behavior is correct for that flow) OR may be confused that "pending edits" carry a date independent of the as-of pill. Wait for the first user-visible wrong outcome, then decide.

**Trigger to revisit:** first user report of "I changed the as-of and my edits got lost" or "my edits applied at the wrong date." Cheap probe in advance: add light telemetry on `(asOf change, dirtyCount > 0)` events to see how often this co-occurs.

---

## read mode shows unsaved local edits as if canonical

**Surface:** `packages/modules/editable-grid/index.tsx` — the cell setter mutates `params.data.values[fieldId]` in place when the user commits a cell edit. The mutation is what makes AG Grid render the new value immediately. When the user switches `mode` to `"read"`, the controller becomes no-op and editable affordances disappear, but the mutated row data stays on the in-memory rows array. Result: a pending edit displays in read mode with no Save button to act on it.

**Current behavior:** read mode renders the live row data, which includes any pending in-place mutations. Edit affordances are suppressed. The controller now exposes `pendingEditsHidden` (count of buffer entries whose dirty glyph is suppressed by the current mode), and `PositionsPage` renders it as a warning-toned "N pending edits — switch to Edit to act" hint next to the mode toggle. So the user gets a textual signal that something local is in flight, but the mutated cell still displays the pending value as if canonical (no `prior` overlay, no visual diff against the server value).

**Defensible alternatives:** (still open — the textual hint is the lightest-touch answer, not the picked answer)
- **Block-or-confirm**: switching to read while dirty prompts "You have N pending edits. Switching to read mode will discard them. Continue?".
- **Auto-revert on read-entry**: dropping into read mode calls `buffer.clear()` AND restores prior values into `data.values`. Destructive but the read view is then accurate.
- **Show pristine in read mode**: the valueGetter consults the buffer in read mode and returns `entry.prior` instead of `data.values[fieldId]`. Non-destructive (edits are still in the buffer, ready to apply on mode-switch back to edit) but adds a branch to every cell read.
- **Keep the current hint and call it done**: a textual count next to the mode toggle is "enough" if the user's mental model treats edits as a top-of-page batch rather than per-cell state.

**Why deferred:** the right answer depends on whether mode-switching is expected to be common (users browse via read, then drop into edit when they need to act) or rare (mode is set per-page-context and users don't toggle). The spike-level toggle in PositionsPage exists to FIND that out; the production answer follows the actual usage pattern. The `pendingEditsHidden` hint is a lightest-immediate defense ("user can't be in read mode without SOME local cue that they have pending work") while the real product debate plays out.

**Trigger to revisit:** first user report of "I switched modes and my edit looked saved but wasn't" — OR — when mode is wired into routing (different pages get different modes), at which point the toggle goes away and the question becomes purely "what happens when a sibling tab navigates from edit to view while dirty."

---

## sheet form validation only fires on Create-click

**Surface:** `apps/hc/frontend/src/pages/NewPositionSheet.tsx` — required-field validation runs at Create-click, not on per-field blur. A user can type a 1-character title, tab away, and only learn it's invalid when they try to submit.

**Current behavior:** Create button gates on `validateRequired(state)`; per-field errors don't surface until Create is clicked.

**Defensible alternatives:**
- **Validate on blur per field**: matches inline-grid editor behavior (validation runs on every commit). Users see errors immediately as they tab through fields.
- **Validate on type, debounced**: more aggressive; can feel noisy.
- **Keep Create-click only**: simplest; matches the "review and confirm" model some users prefer for new-record creation.

**Why deferred:** sheet forms have different conventions than inline editors; users expect different behaviors. Inline cells fire on every commit because the user is in flow. New-record sheets are a "compose then commit" surface; some users prefer to fill freely without per-field nagging.

**Trigger to revisit:** first user report of "I had to scroll up to see what was wrong." Implementation: trivial — the engine validators (`required`, `textLength`, etc.) already exist; sheet just needs to call them on blur.

---

## record-level pending change context

**Surface:** `packages/modules/editable-grid/index.tsx` and `apps/hc/frontend/src/pages/PositionsPage.tsx` — dirty cells mark frontend-staged edits, but the row does not yet summarize all pending state that might affect the user's decision: staged unsaved edits, persisted draft change_sets, and future-dated mainline versions.

**Current behavior:** staged frontend edits show a per-cell dirty glyph and the submit controls show an aggregate dirty count. Draft change_sets and future-dated mainline rows are not shown in-context on the record row. The user can edit a staged cell by editing the cell again, but there is no row-level panel for changing the staged effective date, changing the eventual change_type, or reviewing the pending row diff.

**Defensible alternatives:**
- **Cell-first, lightweight**: keep the dirty glyph + per-cell undo as the primary affordance; add a hover/focus tooltip with prior value and effective_start.
- **Row pending-changes drawer**: clicking a dirty row opens a side panel with frontend-staged edits, server drafts, and future versions, plus controls to change effective date / change_type before submit.
- **Inline pending strip**: row renders a compact "N pending" strip under the primary row with chips for staged, draft, and future-dated changes.
- **Submit-dock owns it**: keep rows quiet; the submit dock expands to show all pending writes and lets users edit effective date / change_type there.

**Why deferred:** this is a product decision, not a correctness patch. The immediate correctness bug — temp-row edits after as-of changes splitting into multiple create writes — is fixed by anchoring temp-row edits to the row's staged effective_start. The broader question is how much pending-state fidelity belongs in-row versus in a review surface.

**Trigger to revisit:** before enabling draft submit mode or future-dated mainline planning beyond the spike. At that point, a user can reasonably need to compare frontend-staged edits, persisted drafts, and scheduled mainline rows for the same record before deciding what to save.

---

## no keyboard shortcut for Save

**Surface:** `apps/hc/frontend/src/pages/PositionsPage.tsx` — Save is mouse-click only. Cmd+S / Cmd+Enter is muscle memory for power users in any edit surface.

**Current behavior:** click the Save button to commit. No shortcut.

**Defensible alternatives:**
- **Cmd+S** binds to Save (overrides browser save-page-as).
- **Cmd+Enter** binds to Save (less collision-prone but less universal).
- **Both**.

**Why deferred:** browser Cmd+S override is the right default for an editable surface but fights muscle memory in some workflows (researchers who actually want to save the page HTML are rare but exist). No data on user pattern yet.

**Trigger to revisit:** first user mention of "I keep hitting Cmd+S and nothing happens." Implementation: `useEffect` keyboard listener at the page level, scoped to when `controller.isDirty === true`.

---

## "add multiple positions" sheet counter

**Surface:** `apps/hc/frontend/src/pages/NewPositionSheet.tsx` — Hari noted in the spike conversation: "we will later add a dropdown option on add position to add multiple in-sheet, with a counter."

**Current behavior:** Create stages one new record per sheet open. Adding three positions requires opening the sheet three times.

**Defensible alternatives:**
- **Counter dropdown** on Create ("Create 1 ▾") that lets the user stage N copies of the form's values as N drafts.
- **"Create another"** secondary button that stages the current values + clears the form (vs. closing the sheet).
- **Multi-row sheet**: the sheet renders N field-rows that the user can fill independently, then Create stages all N.

**Why deferred:** unclear which pattern matches actual headcount-planning workflows. Bulk-add via CSV is the obvious complement (already in the app's broader scope).

**Trigger to revisit:** product asks; or first user signal of "I added 8 positions one at a time and it took forever."

---

## discard during in-flight save → revert lost to reload race

**Surface:** `packages/modules/editable-grid/index.tsx` — `revertField`, `revertRowEdits`, `revertBulkGroup`. The save loop snapshots buffer entries BEFORE awaiting `apply()`, then on success calls `onApplied?.()` which the page wires to `useRecordReads.reload()`.

**Failure mode if unguarded:** user clicks Save → `save()` dispatches `apply()` → before it resolves, user clicks Discard on the same row → revert path drops the buffer entry + restores `row.values` to the captured prior → apply resolves successfully → `onApplied` reloads → the kernel returns the SAVED value (the change DID land — the user-action ordering was "Save first, then Discard, but the kernel never saw the Discard") → row repaints with the saved value. From the user's perspective: they clicked Discard last, but the value shows as if Save won. There is no kernel-side revert path in V0; we can't compensate on the server.

**Current behavior (P11 P2 fix):** all three revert paths short-circuit with a `console.warn` while `submitting === true`. The user's Discard click is rejected at the boundary; they can retry once save resolves. This is a CHEAP defense — the right answer is plumbing a real kernel revert request on top of a successful save when the user races them, but that requires a new kernel endpoint shape (revert-by-record-key-at-effective-start) and idempotency-key coordination that's out of scope for V0.

**Defensible alternatives (real fix):**
- **Kernel-revert composition**: revert mid-save records the discard intent; on save success, dispatches a follow-up revert against the just-saved record_key. Requires kernel support for revert-by-key (today's `/api/revert` is by `change_set_id`, which we don't know until apply resolves — a chicken-and-egg).
- **Optimistic UI revert + reload-aware diff**: revert mutates the visible row even mid-save; the post-apply reload's diff is compared against the user's discard intent; if the saved value differs, the reload IS the revert (already saved → already discarded since the user's discard preempts the read). Subtle; depends on the kernel actually persisting the discard before reload fires.
- **Disable the discard affordance during save**: the row-meta strip's discard icon dims while `submitting`. Today's guard is at the controller boundary (defensive), not the visual affordance. Layering both means the user gets the affordance feedback at the click target, not just a silent console.warn.

**Trigger to revisit:** first user report of "I clicked Discard but the change saved anyway" — OR — when we ship a kernel-side revert-by-record-key endpoint (which unblocks the kernel-revert composition path).

---

## How to use this doc

When you hit an interaction question that has multiple defensible answers and the V0 implementation picked one without product evidence, add an entry here instead of:
- silently hardcoding the chosen behavior (the next contributor won't know why), or
- adding a TODO in code (gets stale, hidden in a giant file).

When a product debate resolves, delete the entry (or move resolved-with-rationale into `docs/principles.md` if it became architectural).
