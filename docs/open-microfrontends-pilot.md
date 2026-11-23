# OpenMicrofrontends SSR Protocol Pilot

## Decision

**Decision: do not promote the protocol to production.** The test-only Vendor
pilot proved that an isolated Next 16 host could consume a standards-conforming
description, request settled SSR HTML, hydrate it exactly, proxy API requests,
and render generic failures without app-specific host code. It also proved the
wrong browser trust model for Autograph.

The protocol lets a remote app server supply HTML, CSS, an ESM renderer, and an
optional head script. Executing those resources in the shell document grants
them the shell origin's browser authority. A compromised app server could read
same-origin responses available to the signed-in user, issue authenticated
mutations, alter the shell UI, and use permitted network channels to exfiltrate
data. CSP, resource signatures, SRI, and app authorization can authenticate or
restrict an expected resource, but cannot sandbox code after the shell chooses
to execute it on its own origin.

Autograph therefore rejects injected remote presentation. The accepted
follow-on architecture uses independently built, reviewed applications as
complete route-owned documents behind a streaming gateway. It does not insert
remote HTML, CSS, scripts, or React trees into the shell document. If
independently controlled UI is required in the future, it must use a separately
originated sandbox or a constrained declarative protocol; same-origin remote
code is not an allowed fallback.

## Evidence retained from the pilot

Commit `7c5d70d3` contained the executable proof. Its automated and browser
evidence covered raw settled provider/account HTML before JavaScript, exact
React hydration, no repeated successful bootstrap requests, no loading flash
or layout shift, server-only request headers, client retry through a generic
API proxy, and generic description/SSR/asset failure states.

The prior Web Fragments line began at `8bea160e`, added a central fragment
registry and custom build assembly in `a3dcb36d` and `36691fbc`, then changed HC
to an iframe in `669c4f15` to recover interactive routing. Earlier Module
Federation experiments (`88d29e2e`, `1543f279`) also required custom host/build
orchestration and were removed in `6127afa2`. The OpenMicrofrontends pilot
successfully tested a different standardized protocol; its removal is a
security decision, not a failure of the protocol proof.

## Production consequence

- The source registry has been removed. The current Vercel deployment remains
  live until the route-owned stack receives separately authorized cutover.
- Production discovery uses ordinary framework projects under
  `apps/`, with generated route data under `.scratch`; it has no app manifest
  or shell import.
- Production never fetches or injects an app description, renderer, stylesheet,
  SSR fragment, or head script into another application's document.
- The `no-runtime-remote-ui-*` ast-grep rules reject runtime module URLs,
  executable-code construction, script injection, external runtime stylesheets,
  and raw HTML sinks with positive and negative fixtures.
- All app routes and APIs remain independently authorized for app, actor,
  organization, and customer scope.
- Reviewed applications sharing the origin remain one browser trust zone even
  when their builds and documents are independent. Route separation is not a
  same-origin security sandbox.

See [Route-Owned Microfrontends](route-owned-microfrontends.md) for the accepted
full-document model.

References: [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy),
[Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity),
and the [OpenMicrofrontends 1.0 specification](https://open-microfrontends.org/specs/1-0-0.html).
