# Integrations design QA

## Comparison input

The review used supplied design references and local browser captures at desktop,
compact, and mobile viewports. Those source images were intentionally ephemeral
manual-QA inputs and are not repository or CI artifacts. The behavioral and
visual acceptance evidence is recorded in the checks below, which can be
reproduced from the app's documented local development flow.

## Review

- Typography: Retains the vendor app type scale and weights while reproducing the reference hierarchy of page title, view toggles, catalog cards, and installed rows. Passed.
- Spacing and layout: Available providers form one desktop row, a consistent two-column compact grid, and one readable mobile column; every action stays aligned to the dedicated bottom row. The installed grid prioritizes recognizable account names without changing row density. Passed.
- Color and state: Existing Autograph tokens provide restrained neutral surfaces, indigo actions, teal healthy states, red disconnected states, and clear disabled states. Status pill text is capitalized. Passed.
- Images and icons: Provider cards use bundled provider marks with no runtime third-party requests; controls use the shared Autograph icon library. No placeholder drawings or emoji are present. Passed.
- Copy: Catalog, setup, health, and installed-account language is specific to vendor and spend operations. Installed rows omit duplicated provider descriptions and technical IDs. The connection-management wrapper does not repeat Ampersand's own security attribution. Passed.
- Interaction: Search filters providers, Discover and Installed toggles switch views without flashing a false empty state, multi-connection providers start another tenant-scoped setup, Escape and close controls dismiss it, and installed rows route back to their exact connection. The Add flow captures a nonblank app-owned connection name before mounting the provider wizard. Passed.
- Accessibility: Search, pressed-state view toggles, provider regions, status blocks, the native modal dialog, and installed table expose semantic roles and accessible names. Compact installed rows show the recognizable connection name, management controls name that exact connection, rows without a scoped group reference disable connection management, the connection-name field exposes required and invalid states, and the modal traps focus and restores it to the invoking card action. Passed.
- Manage-modal composition: At the same 1550 x 712 viewport as the supplied manage reference, the connection-scoped dialog now matches the Add dialog's direct logo-title-close hierarchy. The header eyebrow and pill, installation summary, routine app-owned status card, promotional footer, and duplicate close action are absent. The normal body contains only Ampersand's prebuilt wizard and its own attribution; an app notice appears only for actionable setup failures or completion feedback. Passed.

## Intentional adaptation

The reference uses a generic integration marketplace with a large provider inventory and a separate left navigation. The implementation preserves its discover, setup, and installed hierarchy but uses Autograph's existing vendor shell, the five providers in the canonical catalog, and Ampersand's prebuilt install component inside the app-level setup frame. This avoids inventing duplicate OAuth or configuration UI.

## Iteration history

1. Split discovery and installed-account management into explicit views while keeping a useful installed summary on Discover.
2. Moved active provider setup into a focused native modal around the existing Ampersand component.
3. Tightened the desktop card width so all five providers appear in one row and the installed table remains visible in the first viewport.
4. Replaced runtime provider image requests with bundled brand assets and aligned search and card tags with canonical catalog capabilities.
5. Replaced the app-invented setup progress rail with a native modal frame around Ampersand's prebuilt install UI.
6. Corrected cross-runtime installed-state clearing, disconnected status copy, and mobile installed-row alignment, then captured the mobile Installed view.
7. Removed the provider-count badge and readiness copy, made registered providers non-interactive “Coming soon” cards, and verified the final catalog on localhost.
8. Removed connected providers, availability and capability pills, and contract subtitles from Discover; reduced card hover to a single border treatment and aligned every action in a dedicated bottom row.
9. Restored installed providers that support multiple connections with a clear “Add connection” action while retaining connection-specific management in Installed.
10. Gated the Installed count and empty state on successful active-provider configs, surfaced partial provider failures as unavailable, exposed connection identity on compact rows, and kept provider-level health and sync controls out of connection-scoped management.
11. Added a distinct Installed-view provider management action so provider health and sync controls remain reachable without weakening exact per-connection management.
12. Split Add, provider management, and connection management into explicit dialog intents; made Add a medium-width, wizard-only surface while preserving diagnostics and scoped controls in Manage.
13. Replaced technical installation identity and duplicated descriptions with app-owned connection names, added noncolliding defaults and blank-name gating, and capitalized status pills across desktop and mobile.
14. Reduced connection-scoped management to the Add dialog's direct shell around Ampersand: removed the header eyebrow and status pill, app-owned installation and status layers, promotional footer copy, and redundant footer close action.

No P0, P1, or P2 visual or interaction findings remain.

Final result: passed

## Error-state QA — 2026-07-18

- Source visual truth: selected Product Design error-state reference.
- Implementation evidence: local desktop capture.
- Full-view comparison: manual side-by-side review.
- Responsive evidence: local mobile capture.
- Viewport: 1331 x 728 desktop; 390 x 844 responsive layout check
- State: Integrations page with a critical catalog/activity load failure

**Findings**

- No actionable P0, P1, or P2 differences remain.
- Information architecture: the page identity stays visible while tabs, search, provider catalog,
  installed-account framing, and duplicate alerts are removed from the critical error state.
- Fonts and typography: the existing Autograph font family, title/body scale, weights, and line
  heights are preserved. The error heading and message remain readable without truncation.
- Spacing and layout rhythm: the error uses existing panel radius and spacing tokens, aligns with
  the page header, and has no desktop or 390px horizontal overflow.
- Colors and visual tokens: the panel uses the existing semantic danger border/background tokens;
  the recovery action uses the existing primary-action treatment and retains visible contrast.
- Image quality and asset fidelity: the source state contains no imagery or non-standard icons, so
  no image assets were required or substituted.
- Copy and content: three competing technical errors are replaced by one concise, user-facing
  explanation and one `Retry loading` action. Raw service diagnostics are no longer exposed.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Render one page-level alert for critical catalog, activity, or provider-config failures.
- [x] Hide controls and content that cannot function in the error state.
- [x] Hide partial provider results when any active provider cannot populate the page.
- [x] Retry both page activity and catalog/provider loading paths.
- [x] Verify desktop and responsive layouts in the in-app Browser.
- [x] Test the retry interaction and confirm zero browser console errors.

**Full-view comparison evidence**

The combined comparison shows the annotated duplicate catalog/installed/detail alerts and inert
controls on the left, and the single page-level alert with recovery action on the right. The new
state preserves the surrounding Vendor shell and Integrations page title.

**Focused region comparison evidence**

A separate crop was not needed: the error panel is the only content region in the implemented
state, and its typography, spacing, copy, border, and button are clearly readable in the full-view
comparison.

**Comparison history**

- Pass 1: no actionable P0/P1/P2 findings. The implementation directly resolves every annotated
  issue, uses existing design tokens, and required no post-comparison visual fixes.

**Interaction and browser verification**

- Primary interaction tested: `Retry loading` re-runs loading and returns to the single error state
  when the local authentication failure persists.
- DOM verification: exactly one `alert`; no Integration views group, integration searchbox,
  provider list, or Installed integrations region.
- Browser console: zero error-level entries after reload and retry.

final result: passed

## Authentication transition QA - 2026-07-18

- Source: selected Product Design option 1.
- Implementation: local shell authentication transition at 830 x 862.
- Side-by-side comparison: manual local review capture.
- P0 mismatches: none.
- P1 mismatches: none.
- P2 mismatches: none.
- Notes: the implementation preserves the centered auth card, success icon, workspace-opening
  message, progress indicator, and delayed recovery action while reusing existing auth tokens.
  Navigation starts immediately; the transition represents only actual route loading.

final result: passed
