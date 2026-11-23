# Requirements and decisions

Status: proposed. These decisions describe the target, not current runtime guarantees.

## Product scope

- Hosted integration platforms only, including Ampersand, Merge, and future extensions.
- Organization-shared connections; both platform-managed and customer-owned provider accounts.
- Inbound synchronization, outbound mutations, event triggers, and on-demand actions.
- Multiple apps per connection, multiple connections per source system, and multiple independently named integration uses per app.
- Builder can author and validate missing provider adapters and recipes through ordinary source release. It does not execute model-authored administrator scripts.
- There is no pilot or single-integration completion criterion.

## Objects, fields, and provider choice

AppSpec records product intent. Executable app integration definitions declare required source objects, fields, relationships, operations, freshness, and authority. CUE and generated SQL remain the persisted-schema authority.

Adapters expose versioned checked schemas or discovery metadata, filtered by actual connected-account permissions and commercial capabilities. Builder prefers an authorized existing connection, then suitable organization-preferred configured platforms. Ask only when a material cost, permission, residency, or capability tradeoff remains. Preserve explicit user provider choices.

Mappings target the app's real generated schema, including relationships, collections, enums, dates, money, field clearing, and deletion behavior. Unsupported types require an explicit runtime extension; never coerce them silently or store opaque payloads as a substitute.

Each app declares source authority, conflict resolution, approval requirements, and outbound echo handling. Unspecified destructive behavior is not silently enabled. No automatic provider failover or cross-source identity merging is implied.

## Credentials and central authority

Separate platform, platform account, source system, source connection, app binding, and integration-use identity. Include environment and managed/customer-owned mode.

The central connection control plane is required. It owns authorization, lifecycle, bindings, grants, and revocation, not payloads, mappings, credentials, or sync cursors.

A separate protected credential service stores platform API keys, customer-owned platform credentials, and per-account tokens. Upstream OAuth remains with the hosted platform. Use encrypted records in a dedicated PostgreSQL credential schema with versioned wrapping keys outside the database. Support rotation, revocation, restricted service access, and opaque-reference audits.

Neither Builder nor browser code receives long-lived secrets. Customer-owned credentials enter through protected setup surfaces, never chat prompts. Runtime access is restricted to an authorized account, connection, and declared operation.

## Compatibility

Preserve existing source references, records, replay behavior, optional app composition, and app-owned business authorization. Provider changes are explicit migrations. No new universal business schema or second AppSpec metadata authority is introduced.

[Architecture](architecture.md) defines the interfaces; [acceptance](acceptance-and-operations.md) defines completion.
