# Vendor Xero Supplier/AP Integration

## U11 runtime contract

Xero imports supplier contacts, accounts-payable invoices, and accounts-payable
credit notes into the provider-neutral Vendor models. The provider-owned
runtime is implemented behind the catalog gate. Both environments remain
`registered` until their signed smoke is recorded; the production deployment
matrix remains gated for the same reason.

The app-owned manifests are
`apps/vendor/integrations/ampersand/xero/development/runtime.yaml` and
`apps/vendor/integrations/ampersand/xero/amp.yaml`. Both use provider `xero`,
the shared signed read destination, and a daily `03:00 UTC` full-read cadence.
The provider app scopes remain exactly `openid`, `profile`, `email`,
`offline_access`, `accounting.contacts.read`, and
`accounting.invoices.read`. Writes, subscriptions, proxy actions, bank
transactions, and broader accounting scopes are not allowed.

## Provider filters and mapping

Ampersand cannot predicate Xero rows in the manifest. The signed provider
ingress therefore partitions each complete delivery before trusted apply:

- `contacts` apply only when `IsSupplier === true`;
- `invoices` apply only when `Type === ACCPAY`;
- `creditNotes` apply only when `Type === ACCPAYCREDIT`.

Rejected rows never enter the apply compiler. A mixed full read applies its
eligible rows and reports accepted/rejected counts; a read with no eligible
rows is acknowledged without a change set. The provider recipe maps supplier
contacts to `vendor`, invoices to `vendor_spend_transaction` kind `bill`, and
credit notes to kind `credit`. Invoice totals/open amounts stay positive.
Credit-note totals and remaining credit are normalized negative. Document
contact references resolve only through the same installation's Xero contact
source reference; ambiguous or missing canonical relations fail at apply.

Every installation uses a slot-scoped group ref
`<customer_id>:xero:<uuid>`. Provider and installation identity remain app data
and provenance, not kernel identity. Shared Svix destination secrets authenticate
the project callback, while integration, installation, config, provider,
operation, health, group, and timestamp authority are re-read from Ampersand
before apply. Replay uses the signed message/operation/object identity and the
ordinary persisted `change_set` idempotency path.

## Measured full-read budgets

U8 measured 53 contacts / 67,515 bytes, 77 invoices / 184,733 bytes, and four
credit notes / 11,188 bytes, each using one provider GET/page. U11 permits at
most twice each measured record and byte count:

| Object        | Record budget | Byte budget |
| ------------- | ------------: | ----------: |
| `contacts`    |           106 |     135,030 |
| `invoices`    |           154 |     369,466 |
| `creditNotes` |             8 |      22,376 |

The ingress requires `resultInfo.numRecords`, rejects either limit with `413`,
and pauses the rejected object through Ampersand. Widening a budget requires a
new representative full-read measurement and a cadence review. The daily
86,400-second cadence remains far above twice the largest measured duration
(82.392482 seconds).

## Operations and rollout

Provider-specific operator commands use the ignored local fnox profile and do
not print secrets:

```sh
mise //apps/vendor:ampersand:xero:verify -- development
mise //apps/vendor:ampersand:xero:deploy -- development
mise //apps/vendor:ampersand:xero:sync-provider-app -- development
mise //apps/vendor:ampersand:xero:sync-destinations -- development
mise //apps/vendor:ampersand:xero:sync-notifications -- development
mise //apps/vendor:ampersand:xero:resume-and-trigger -- development \
  --installation-id <installation-id> \
  --object contacts
```

Production mutations additionally require
`PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true`. Xero shares the project read and
notification destinations/signing secrets but has its own provider app and
`AMPERSAND_XERO_INTEGRATION_ID`. Environment-specific operations use
`AMPERSAND_DEVELOPMENT_XERO_INTEGRATION_ID` and
`AMPERSAND_PRODUCTION_XERO_INTEGRATION_ID` plus the matching
`AMPERSAND_<ENVIRONMENT>_XERO_{CLIENT_ID,CLIENT_SECRET,SCOPES,PROVIDER_APP_EXTERNAL_REF}`
inputs. The resume command first fetches the installation and derives its
validated slot-scoped group, then uses Ampersand's object-scoped unpause
endpoint and triggers a full asynchronous read for that same group. Trigger
failure re-pauses the object before returning an error.

Production activation is fail-closed. Keep catalog production launch and the
GitHub production manifest matrix `registered`/disabled until one controlled
production installation proves all of the following against the exact checked
manifest and recipe head:

- signed full reads for supplier contacts, AP invoices, and AP credit notes;
- representative applied vendor/bill/credit records and supplier relations;
- non-supplier, sales invoice, and sales credit rejection counts;
- exact replay returning the existing change set;
- healthy installation/operation authority and shared-signature routing;
- an over-budget or malformed provider read pausing only the affected Xero
  object, followed by an operator resume and successful read; and
- a second slot-scoped installation remaining isolated.

Only the change that records sanitized evidence for every item may set Xero
production launch to `active` and enable `vendor-xero` in the production deploy
matrix. Development and production proof must use separate Ampersand project
credentials.
