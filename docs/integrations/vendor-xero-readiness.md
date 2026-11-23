# Vendor Xero Supplier/AP Readiness

## U8 development-only gate

Xero remains registered, not active, in the vendor integration catalog. U8
proves the provider contract before shared schema finalization. It does not add
Xero to production deployment, runtime apply, or the production catalog lane.

The provisional manifest is
`apps/vendor/integrations/ampersand/xero/development/amp.yaml`. It may be
deployed only to the Ampersand development project and contains exactly three
read objects:

- `contacts`, accepted downstream only when `IsSupplier` is `true`;
- `invoices`, accepted downstream only when `Type` is `ACCPAY`;
- `creditNotes`, accepted downstream only when `Type` is `ACCPAYCREDIT`.

Ampersand's read manifest bounds objects and fields but does not provide a
provider-row predicate. The evidence therefore correlates sanitized records to
their captured delivery envelopes and proves the deterministic post-delivery
accept/reject decision. It must not claim that ineligible rows were filtered by
the provider manifest.

Bank transactions, sales invoices (`ACCREC`), sales credit notes
(`ACCRECCREDIT`), non-supplier contacts, write actions, proxy actions, subscribe
actions, and automatic optional-field expansion are outside U8 and V0.

The provider app must have exactly these scopes: `openid`, `profile`, `email`,
`offline_access`, `accounting.contacts.read`, and
`accounting.invoices.read`. In particular,
`accounting.banktransactions.read` is not permitted.
The installation proof is for Xero Demo Company (US) in the Ampersand
development project; the organization name and tenant identifiers remain
redacted or sanitized.

## Evidence contract

The live sanitized evidence file is
`docs/integrations/fixtures/ampersand-xero-supplier-ap-readiness.json`. It is an
executable acceptance input consumed by
`mise //apps/vendor:ampersand:xero:readiness-check`.
The checker requires:

- successful OAuth authorization, mapping save, and a triggered full read;
- Hookdeck request references with exact Svix header names, raw-body SHA-256,
  and canonical sanitized Ampersand read-envelope fields: `action`, `projectId`,
  `groupRef`, `installationId`, `installationUpdateTime`, `objectName`,
  `operationId`, `operationTime`, `provider`, `readType`, `resultInfo`, and
  sampled `result[].fields` / `result[].mappedFields`;
- a labeled sanitized full-read analysis bound to each raw-body SHA-256, with
  per-operation duration, Ampersand provider GET/page quota use,
  eligible/rejected aggregate counts, and complete field-coverage counts;
- each fixture's exact sanitized fields SHA-256-bound to a sampled result in
  the corresponding canonical envelope shape;
- accepted and rejected fixtures for every supplier/AP boundary, including a
  representative bank transaction rejection;
- supplier contact linkage for every accepted invoice and credit note;
- exact source IDs, document numbers, vendor names, subtotal/tax/total and
  remaining/due/paid amounts, currency, status, dates, and non-empty line items;
- representative full-invoice-read record counts, delivered bytes, operation
  durations, and API calls used, with the largest selected measurement
  reconciled to its captured invoice operation; and
- a selected cadence at least twice the measured duration.

The evidence is fail-closed: every evidence and record object uses an exact key
allowlist, free text is `redacted`, references use `sanitized_` placeholders,
and the checker rejects UUIDs, Hookdeck source URLs, non-example email
addresses, JWTs, secret material, and sensitive or secret-bearing keys.
Raw customer payloads are deliberately excluded. The Hookdeck request ID,
Ampersand operation ID, and raw-body digest are retained so an authorized
operator can correlate the sanitized sample and aggregate analysis back to the
captured source without committing customer data or credentials.

## Go/no-go

U8 may record either `go` or `no_go` after the complete live evidence passes
the checker. The evidence must set `u11MayStart` to `true` exactly with
`status: go`; a `no_go` decision keeps it `false`. Missing live evidence is an
incomplete gate, not a decision.

The sanitized evidence captured on 2026-07-16 passes this contract and records
the U8 decision as **GO**. Its largest representative full invoice read was 77
records and 184,733 bytes in 41.196241 seconds using one provider GET/page. The
provisional daily cadence is 86,400 seconds, exceeding the required 82.392482
seconds. U11 may start under this supplier/AP-only contract; this decision does
not activate Xero in production or widen V0.

The approved parent fields fit the shared `vendor_spend_transaction` contract:
`InvoiceID` / `CreditNoteID` supply `source_record_id`, document numbers and
contact linkage supply the common document/vendor fields, totals and remaining
or due amounts supply signed `amount` / `open_amount`, and currency, status,
transaction/due/update dates map without Xero-specific schema fields.
`ACCPAY` maps to kind `bill`; `ACCPAYCREDIT` maps to kind `credit` with a
negative signed amount. U11 owns the provider recipe, supplier/AP filters, and
runtime rollout in `vendor-xero.md`.
