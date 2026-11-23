# Shell Host and RSC Decision History

This note records the route from a Vite RSC composition host to the current
route-owned architecture.

## Decisions

The private Shell adapter remains a Next.js App Router composition because Next owns its RSC
payloads, HTML streaming, client-reference manifests, hydration, Server
Actions, Cache Components, and prefetch behavior. It is no longer an RSC host
for other applications.

The earlier source-composed design mounted app-owned renderers below a generic
shell `[appId]` route. It solved the integrations loading flash, but it coupled
every application to a shell renderer/runtime contract and made the shell part
of every app document. That design is superseded.

The current boundary is the HTTP route. Next and Vite zones build and serve
their own complete documents, while a provider-neutral gateway selects the
owner and streams bytes without HTML transformation. A Next zone's RSC and
client navigation remain entirely native inside that zone. Crossing to another
zone is a full document navigation.

Vercel's protected cross-project transport has one request-target projection:
after Gateway authorizes the public document path, a native Next static segment
prefetch is addressed to the equivalent `.segments/*.segment.rsc` artifact
emitted by that same child build. The public URL, owner, signed request target,
response bytes, and runtime RSC navigation are unchanged. Local and OCI
transports keep Next's header-addressed request because their Next server owns
that dispatch directly.

## Comparison

| Concern | Source-composed Next shell | Route-owned zones |
| --- | --- | --- |
| App installation | App manifest, renderer entry, generated shell registry | Add `apps/<name>` with ordinary Next or Vite config |
| RSC | Shell invokes app renderer | Owning Next application controls RSC end to end |
| Traditional SPA | Requires shell client entry/runtime | Served unchanged behind its base path |
| Routing | Shell interprets app paths and APIs | Gateway selects only the owning prefix; app owns the rest |
| Cross-app dependency | Generated imports into shell | No source import across the route boundary |
| Navigation | Shared Next router | Native in-zone; document navigation across zones |
| Deployment | One compiled Next output | Four independent Vercel Services projects; provider-neutral OCI/Compose remains a proof path |

## Security constraint

Route ownership is a deployment boundary, not a browser sandbox. Reviewed
application zones on one origin share browser authority. The OpenMicrofrontends
remote-injection pilot remains rejected: fetched HTML or JavaScript is never
inserted into the shell document. Untrusted UI requires a separate origin or a
sandboxed iframe.

The canonical contract, including the complete project graph and route table,
is [Route-Owned Microfrontends](route-owned-microfrontends.md#deployment-topology).
