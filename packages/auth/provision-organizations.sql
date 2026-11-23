begin;

create table if not exists "public"."app_actor_assignment" (
  "organizationId" text not null references "public"."organization" ("id") on delete cascade,
  "actorId" text not null references "public"."user" ("id") on delete cascade,
  "appId" text not null,
  "role" text not null,
  "active" boolean not null default true,
  "fence_generation" bigint not null default 0,
  "assignedAt" timestamptz not null default now(),
  primary key ("organizationId", "actorId", "appId", "role"),
  constraint app_actor_assignment_fence_generation_nonnegative check ("fence_generation" >= 0)
);

alter table "public"."app_actor_assignment"
  add column if not exists "fence_generation" bigint not null default 0
  constraint app_actor_assignment_fence_generation_nonnegative
  check ("fence_generation" >= 0);

create table if not exists "public"."app_signup_policy" (
  "id" text not null primary key,
  "authResourceId" text not null,
  "resourceDigest" text not null check ("resourceDigest" ~ '^[a-f0-9]{64}$'),
  "appId" text not null,
  "origin" text not null,
  "appPath" text not null,
  "organizationId" text not null references "public"."organization" ("id") on delete cascade,
  "eligibility" text not null check ("eligibility" in ('public','approved-email')),
  "allowedEmails" jsonb not null default '[]'::jsonb,
  "membershipRole" text not null check ("membershipRole"='member'),
  "appRoles" jsonb not null,
  "operationRef" text not null,
  "planDigest" text not null check ("planDigest" ~ '^[a-f0-9]{64}$'),
  "policyDigest" text not null check ("policyDigest" ~ '^[a-f0-9]{64}$'),
  "fenceGeneration" bigint not null check ("fenceGeneration" >= 0),
  "createdAt" timestamptz not null,
  constraint "app_signup_policy_scope_unique" unique ("resourceDigest", "origin", "appPath")
);
alter table "public"."app_signup_policy"
  add column if not exists "fenceGeneration" bigint not null default 0 check ("fenceGeneration" >= 0);

-- Managed Production policies are distinct from legacy generation-zero enrollment.
alter table public.app_signup_policy
  add column if not exists "admissionMode" text not null default 'legacy'
    check ("admissionMode" in ('legacy','managed-production')),
  add column if not exists "workspaceId" text,
  add column if not exists enabled boolean not null default true,
  add column if not exists "signupStorage" text check ("signupStorage" in ('none','postgres'));

create table if not exists public.app_access_invitation (
  id text primary key,
  "workspaceId" text not null,
  "resourceDigest" text not null,
  "appId" text not null,
  "organizationId" text not null references public.organization(id),
  email text not null,
  roles jsonb not null,
  "returnUrl" text not null,
  "operationRef" text not null,
  "planDigest" text not null,
  "scopeDigest" text not null,
  "fenceGeneration" bigint not null check ("fenceGeneration" > 0),
  status text not null default 'pending' check (status in ('pending','verified','accepted','cancelled')),
  "expiresAt" timestamptz not null,
  "verifiedActorId" text references public."user"(id),
  "verifiedSessionId" text,
  "verifiedAt" timestamptz,
  "deliveryStatus" text not null default 'ready' check ("deliveryStatus" in ('ready','sending','sent','unknown')),
  "deliveryAttemptId" text,
  "deliveryProviderId" text,
  "createdAt" timestamptz not null default now()
);
alter table public.app_access_invitation
  add column if not exists "linkedFromInvitationId" text references public.app_access_invitation(id);
alter table public.app_access_invitation
  add column if not exists "signupPolicyId" text references public.app_signup_policy(id),
  add column if not exists "signupPolicyDigest" text,
  add column if not exists "signupGrantFence" bigint check ("signupGrantFence">0),
  add column if not exists "signupGrantOperationRef" text,
  add column if not exists "signupGrantFences" jsonb not null default '[]'::jsonb check (jsonb_typeof("signupGrantFences")='array');
-- One immutable claim per app/actor, across policy replacements and revoked access.
create unique index if not exists app_access_signup_actor_unique
  on public.app_access_invitation("workspaceId","appId","organizationId","verifiedActorId")
  where "signupPolicyId" is not null;
create index if not exists app_access_invitation_app_idx
  on public.app_access_invitation("workspaceId","appId","organizationId");

-- App admission is distinct from business roles, including apps without roles.
create table if not exists public.app_actor_access (
  "organizationId" text not null references public.organization(id),
  "actorId" text not null references public."user"(id),
  "appId" text not null,
  "workspaceId" text not null,
  active boolean not null,
  roles jsonb not null,
  "fenceGeneration" bigint not null check ("fenceGeneration">0),
  primary key ("organizationId","actorId","appId")
);


insert into "public"."organization" ("id", "name", "slug", "logo", "createdAt", "metadata", "appIds")
values ('hc', 'HC', 'hc', null, now(), null, '["hc"]'::jsonb),
       ('vendor', 'Vendor', 'vendor', null, now(), null, '["vendor","integrations"]'::jsonb),
       ('dev', 'Dev', 'dev', null, now(), '{"signupAccess":"all-apps"}', '__CATALOG_APP_IDS__'::jsonb)
on conflict ("id") do update
set "name" = excluded."name",
    "slug" = excluded."slug",
    "metadata" = excluded."metadata",
    "appIds" = (
      select coalesce(jsonb_agg(to_jsonb(app_id) order by app_id), '[]'::jsonb)
      from (
        select jsonb_array_elements_text(
          case when jsonb_typeof("organization"."appIds") = 'array'
            then "organization"."appIds" else '[]'::jsonb end
        ) as app_id
        union
        select jsonb_array_elements_text(excluded."appIds") as app_id
      ) retained
    )
where ("organization"."name", "organization"."slug", "organization"."metadata")
      is distinct from (excluded."name", excluded."slug", excluded."metadata")
   or not coalesce("organization"."appIds", '[]'::jsonb) @> excluded."appIds";

commit;
