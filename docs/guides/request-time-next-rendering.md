# Request-time rendering in generated Next apps

Native Next apps use Cache Components and partial prefetching through
`@autograph/next-config`. When adding authenticated forms or data views, keep
the static page shell synchronous and render request-dependent components
inside a narrow `Suspense` boundary with a meaningful loading state.

## One full-stack Next application

Server Components call server-only app-owned functions over the generated
PostgreSQL operations directly. Keep those functions beside the owning route
or feature. Commands invoked by client controls belong in dedicated `"use server"`
action modules, with input validation and fresh authorization inside each action.
Do not introduce a separate backend service, REST CRUD layer, or fetch the app's
own Route Handler from a Server Component or Server Action.

The optional CUE input adds a data foundation to the same Next application.
The generated scaffold does not add a schema GET route or a readiness receipt.

## Next.js 16.4 navigation and mutations

The shared config enables `cacheComponents` and `partialPrefetching`. Follow
[Building app-like experiences with Next.js 16.3](https://nextjs.org/blog/building-app-like-experiences-with-nextjs-16-3),
[Next.js 16.4](https://nextjs.org/blog/next-16-4), and the
[16.4 navigation optimization walkthrough](https://nextjs.org/blog/improving-navigation-experience-in-v0-with-nextjs-16-4).
Keep persistent navigation in layouts and use native `Link` components within
one Next app. Default prefetching prepares the route shell; `prefetch={true}`
can also resolve URL-specific cached content before the click. Use richer
prefetching for a small fixed navigation set. In long lists, start it on hover,
keyboard focus, or touch instead of fetching every row's details on visibility.
Show pending feedback with `useLinkStatus` in a small client leaf. Do not move
server reads into a client effect to make navigation appear faster.

Server Components read through the server-only `app/data/` DAL; Server Actions
validate browser input and delegate authorized mutation commands to that DAL.
Keep independent reads concurrent and put uncached sections beneath narrow
Suspense boundaries. Keep useful shell content visible while the data streams.
Use section-sized fallbacks to reserve space rather than replacing the whole app.

### Choose the navigation stage

Use the [navigation stages](https://nextjs.org/docs/app/glossary#navigation-stages)
to decide when each subtree should render:

| Stage | Server-rendered content |
| --- | --- |
| App Shell | Reusable layout, useful primary content, and section fallbacks prepared by default links |
| Per-link prefetch | URL-specific cached content for selected links using `prefetch={true}` |
| Navigation | Remaining uncached or intentionally deferred work streamed after the click |

For expensive content that can wait for a per-link prefetch, call
[`await prefetch()`](https://nextjs.org/docs/app/api-reference/functions/prefetch)
from `next/cache` before the read in a Suspense child. Per-link data reuse
requires a suitable cache scope and lifetime; uncached reads and data that
cannot safely be cached remain navigation-time work. For content that should
wait until navigation, use
[`await navigation()`](https://nextjs.org/docs/app/api-reference/functions/navigation).
Keep both calls outside cached functions. They defer their subtree; static
prerenders can still include its content. Keep authentication and authorization
in the server-owned read or command regardless of the stage.

Place fallbacks below the layout shared by the source and destination routes.
A boundary above that shared layout may cover direct loads without handling the
client transition. Preserve headings, navigation, focus, and useful geometry as
independent sections stream.

Follow [Ensuring instant navigations](https://nextjs.org/docs/app/guides/instant-navigation)
and [Optimizing prefetching](https://nextjs.org/docs/app/guides/optimizing-prefetching).
For a selected product interaction, define which useful UI must be ready at
the click, then use the official `instant()` helper from `@next/playwright`
against a production build to verify that target. Check warm-cache revisits,
Back/Forward, cache expiry, and successful mutation invalidation separately.
Automatic prefetching runs in production, so development navigation alone does
not prove it. Cold-cache behavior remains a separate observation.

Read the installed version's guidance before upgrades. The official
[`next upgrade` command](https://nextjs.org/docs/app/api-reference/cli/next#next-upgrade-options)
can supply version-matched agent migration guidance. Builder resolves concrete
compatible stable versions for accepted creation or explicit upgrade plans;
ordinary existing-app edits preserve their versions. Use the repository-owned
upgrade operation for the shared catalog and package-manager lockfile.

### Cache scope, freshness, and mutation invalidation

Choose a cache scope for actual feature data; the generator installs no default
cache lifetime or sample data functions. Plain `'use cache'` is for results safe
to share under their explicit arguments. Private workflow results can use
`'use cache: private'` with an explicit `cacheLife({ stale: ... })` so rendered
output can be reused in browser memory without a persistent production server
cache across requests. Include the feature's tenant/resource/filter identity,
authorize inside the private read when it executes, and return minimal DTOs.
Browser reuse is not renewed authorization; commands always resolve and check
current identity and permissions. Do not cache credentials, submission tokens,
or mutable authenticated context. Session changes must discard the previous
session's router view. Follow the installed framework's
[`use cache: private` reference](https://nextjs.org/docs/app/api-reference/directives/use-cache-private)
for request APIs and lifetime constraints; choose freshness per feature.

Tag cached reads and, after successful persistence, use `updateTag` from the
Server Action for read-your-writes, plus `revalidatePath` for affected paths.
Invalidate on successful idempotent recovery as well as a new write. Use
`revalidateTag(tag, "max")` only when stale-while-revalidate fits the feature.
Use `useActionState` or `useFormStatus` in small client leaves for pending and
expected errors. Add optimistic UI only with a clear rollback; keep unexpected
failures in the route error boundary.

For expensive secondary content that should wait until navigation, use
`await navigation()` from `next/cache` before starting that work, outside cached functions,
inside a Suspense-wrapped child. Its fallback can be prefetched while the work
waits for the click. This is separate from `connection()`, which defers
request-specific work. Do not put the primary heading or essential detail
behind `navigation()` merely to avoid a useful prefetch. `ensureStatic` is an
optional feature-specific cost choice, never a blanket generated-app gate.

### Transitions and accessibility

React 19.3 supplies stable `ViewTransition`. Wrap only changing content or a
Suspense reveal, keeping persistent navigation outside that boundary. Prefer a
short crossfade, respect `prefers-reduced-motion`, and retain normal navigation
where the browser lacks View Transition support. Native `Link` transition types
can distinguish intentional forward/back motion when that conveys meaning.
Do not key the entire app layout by pathname, add a parallel client router, or
animate the whole document on every mutation. Experimental `useOffline` is not
a production default.

## Put the read inside the boundary

Session and tenant resolution, `cookies()`, `headers()`, `connection()`,
uncached database reads, and request-dependent `params` or `searchParams`
resolution belong inside the child component. Pass route promises into that
child without awaiting them in the outer page. A boundary returned after a
top-level request read cannot contain that earlier read.

For a request-specific form token, keep the heading outside the boundary and
resolve the authenticated token inside it. In this example `submissionToken`
is the app-owned server helper and `RequestForm` is its client form leaf:

```tsx
import { Suspense } from "react";
import { connection } from "next/server";
import { RequestForm } from "./request-form";
import { submissionToken } from "./data";

export default function NewRequestPage() {
  return (
    <main>
      <h1>Submit a request</h1>
      <Suspense fallback={<p role="status">Loading request form…</p>}>
        <AuthenticatedForm />
      </Suspense>
    </main>
  );
}

async function AuthenticatedForm() {
  await connection();
  const requestToken = await submissionToken();
  return <RequestForm requestToken={requestToken} />;
}
```

Use `connection()` only when request-time work needs it, such as a fresh random
token; session helpers that already read request APIs need no extra call.
`connection()` defers work until a request; it does not supply a Suspense boundary
or authorization. Form tokens and page rendering never authorize an action.
Actions still validate input and resolve trusted tenant/actor scope on every
invocation.

`loading.tsx` supplies a framework boundary for the segment it wraps. Check its
actual placement, especially for shared layouts and new nested routes. Use an
explicit component boundary when the static heading and navigation should
remain visible while a form or authorized data view resolves. Do not cache
session resolution, tokens, or private mutable workflow data merely to silence
an uncached-render diagnostic, disable Cache Components, or add blocking opt-outs
as the generated default.

## Verify the completed workflow

Run the owning repository's app check/test commands and exercise the affected
route in a browser through both direct load and in-app navigation. Verify the
loading state resolves to the actual authorized form or data; a heading, HTTP
200, or partial-prerender build result alone is insufficient. For a mutation,
verify confirmation, selected detail, independent persisted-record readback,
and reload. Preserve the scenario's tenant, role, self-approval, conflict and
fresh-process persistence assertions where applicable. Do not weaken a failing
assertion or call a still-failing app repaired because generation guidance changed.

Keep historical failed receipts. New reports identify the tested revision and
working-tree digest, and distinguish repository/local validation from public
Builder generation and hosted acceptance. The retained Spend Review submission
failure motivates this guidance; this documentation does not repair that app or
claim a passing rerun.

Consult the installed Next package documentation first, plus the official
[Cache Components guide](https://nextjs.org/docs/app/getting-started/cache-components)
and [`connection()` reference](https://nextjs.org/docs/app/api-reference/functions/connection).
