# Currency rates

Currency conversion is a live lookup of a currency pair at an explicit date.
One stored quote serves both directions: multiply in its entered direction and divide
in the reverse direction. Source amounts are never rewritten. Correcting an
old rate changes subsequent calculations for that period. No frozen result, forecast
row, rate-set entity, or app placement is introduced.

## Stored rates

`@domain-libs/accounting` exports `model_exchange_rate_blocks` separately from existing
accounting models. The generated domain catalog exposes `exchange_rate` for opt-in
CUE selection. Existing apps do not acquire the model automatically. Select the model
with its declared field IDs unchanged; require `source_currency`,
`target_currency`, and `origin`. Keep `rate` and `observation_date` optional. The
test-owned `packages/currency-rates/__tests__/exchange-rates.cue` is a
minimal compiled example. Normal schema installation and tenant grants still apply.

Each tenant has at most one canonical record per unordered pair and origin. The adapter
sorts the two codes for the kernel-owned unique external key `EUR/USD/custom` or
`EUR/USD/frankfurter`. The existing source/target fields preserve the entered quote
direction and the rate string is stored unchanged. Entering USD/EUR updates the same
custom identity as EUR/USD; no reciprocal rate is persisted. Successive rates are versions of that record, not new records.
Kernel effective dates, same-date correction ordering, audit and idempotency remain
authoritative. Currency codes use the kernel's tender-code vocabulary; rates are
positive kernel-compatible decimal strings.

Kernel version periods are the only effective-date authority. A finite custom save
atomically writes the entered rate at its start and a rate-less custom boundary on
the day after its inclusive end. Returning to automatic writes the same rate-less
boundary explicitly. Neither operation deletes history or alters provider rates.
A user-entered rate overrides the canonical Frankfurter rate for its effective
period; every other date uses the canonical rate when available. Custom periods are
sequential: a later custom version closes the earlier kernel period on the day
before its start, even if the earlier rate was open-ended. For example, an open-ended
custom rate starting September 5 followed by a September 10–20 custom rate applies
only through September 9; the successor applies through September 20 inclusive, and
September 21 returns to Frankfurter. Expiry never resurrects a superseded custom
version. The most current custom rate may remain open-ended until a successor or an
explicit return to automatic closes it. A request date resolves custom, then Frankfurter, then
explicitly missing. Same-currency conversion returns identity without a stored rate.
Ambiguous active rows fail instead of choosing an arbitrary winner.

## Server preparation and use

`@autograph/currency-rates` exports `createCurrencyRateStore`, `resolveCurrencyRate`
and `convertCurrency`. Bind the store to an authenticated, authorized server's
canonical kernel client, immutable tenant scope, and actor. The adapter does not
establish authorization, install schemas, or grant access. Its raw canonical-operation
path requires external-key writes; policy-enabled generated data paths that prohibit
those writes need an authorized host integration before adoption.

- `saveCustom(rate, { idempotencyKey, expectedVersionId? })` writes a custom version
  and, for a finite period, its automatic successor in one change set. A correction
  passes the prior period end as `previousEffectiveEnd` so extending or reopening a
  finite period replaces its former automatic boundary atomically.
- `useAutomatic({ sourceCurrency, targetCurrency, effectiveStart }, options)` writes
  the rate-less custom version. Optional expected-version checks use kernel semantics.
- `importMonthly({ sourceCurrency, targetCurrency, month }, options)` fetches one
  selected first-of-month observation and writes the provider version. The host invokes
  it once for each needed pair/month, using a stable key for retries of that import.
  A deliberate provider refresh/correction uses a new idempotency key.
  This host-requested public-data preparation uses ordinary `source_kind = 'data_import'`
  with the bound actor and provider provenance. Connected-account integration ingestion
  uses its separately provisioned service identity.
- `read({ sourceCurrency, targetCurrency, asOf })` reads live kernel-selected versions
  for the bound tenant and returns applicable rates. It performs no provider requests.
- `history({ sourceCurrency, targetCurrency })` supplies the editor's live effective
  periods, newest first, by walking kernel version boundaries rather than daily dates.
  After discovering the pair's stable record IDs, later history reads are constrained
  to those records.
  It covers the store's stable open-ended identities, not deleted-record audit history.
- `resolveCurrencyRate` returns the stored quote as evidence and an explicit
  `operation` (`multiply` or `divide`) for the requested direction.
- `convertCurrency(amount, rates, request)` uses exact decimal multiplication and
  exact division when the result terminates. Repeating division is rounded to 28
  significant digits, half-even, without binary floating-point arithmetic.
  Formatting and accounting/display rounding remain the caller's responsibility.

The host can reuse a read's rate array for every calculation with the same pair/date.
Stored provider versions are reusable data; conversion results are not cached. Hosts
must refresh their displayed reads after a successful write. This library does not
introduce realtime subscriptions, a scheduler, or a deployment-owned sync service.
App adoption, scheduling and permission wiring remain deferred.

## Monthly automatic defaults

The reference date is the **1st** of each month. `fetchFrankfurterMonthlyRate` uses
Frankfurter v2's single-pair endpoint with `date=YYYY-MM-01`; it does not use monthly
averages. It requests only the needed pair in sorted-code order, so asking for the reverse
direction cannot create a second provider quote or change its rounding. The returned date is retained as provider
response provenance, and must not be later than the reference date. Providers may
carry observations across non-publication days; the response date is not a promise
that the market published a new observation that day.

The effective start is the reference date. A new monthly version closes the preceding
version through normal kernel mechanics. The latest version remains open-ended,
covering today and future dates until another monthly version arrives. No future
observations are requested and no future-month rows are generated. This is reference
conversion, not a market forecast. Custom overrides always take precedence.

The public default blended feed is used. Numeric JSON tokens are preserved as decimal
strings (Node 24/Bun reviver-context support is required). Requests time out, malformed
or mismatched responses fail, and unsupported pairs return unavailable without a
write. Failed preparation leaves previously stored rates intact. No fallback of 1
is supplied for different currencies.

## Package editor

`CurrencyRateEditor` in `packages/modules/editable-grid` accepts a selected pair, supplied
rate periods, and async `onSave` / `onUseAutomatic` callbacks. It displays effective
periods and Automatic/Custom provenance, edits custom periods, and restores automatic
selection from an explicit date. Automatic rows are read-only. Editing a custom row
corrects that period at its existing start; the start stays fixed, and its version ID
is returned for optimistic correction. Add rate opens a
new inline row with today as the suggested start and no end date selected by default.
The shared date picker and optional end date keep finite overrides available.
A shared direction selector lets users enter either quote. `onSave` includes the
entered `sourceCurrency` and `targetCurrency`; hosts pass those through to `saveCustom`
instead of overwriting them with the selected viewing pair. Switching the selector
changes the interpretation, not the typed number. Editing restores the saved quote
direction. Explicit `1 EUR = … USD` labels replace wrong-direction heuristics.
One AG Grid table shows the effective timeline, with shared controls for inline additions and corrections. Custom periods hide the automatic rate over the dates they cover; automatic periods are clipped to the remaining gaps and stay read-only. Each rate displays its currency direction. The host loads `store.history(pair)`, binds authorized
callbacks, and refreshes the controlled data after successful writes; the component performs no network or
kernel calls. Raw historical same-date superseded versions must not be passed to the
conversion resolver as simultaneous effective periods. Normal audit history remains
available through the existing kernel activity and change-set diff operations.

The component retains drafts on failure and disables duplicate pending submissions.
It has no app routes, pair-management framework, approval state, source selector or
monthly-day selector. Storybook examples cover populated, empty and failed-save states.

## Verification

Package tests cover exact arithmetic, precedence, date/decimal validation, provider
validation and scoped writes. The PostgreSQL proof compiles a minimal test-owned CUE
schema, installs it for two tenants in a disposable database, and exercises monthly
succession, corrections, inclusive overrides, automatic restoration and tenant isolation through
the actual generated kernel. Component tests exercise the edit/save/error flows.
