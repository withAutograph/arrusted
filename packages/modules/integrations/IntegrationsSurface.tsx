import { useId } from "react";
import { StatusPill } from "../../design-systems/core/components/StatusPill";
import { IntegrationActions, IntegrationRefresh } from "./IntegrationActions";
import { IntegrationCatalog } from "./IntegrationCatalog";
import type { IntegrationSectionState, IntegrationStatus, IntegrationsSurfaceProps } from "./types";
import "./integrations.css";

/** No effects or fetches: loaded data is useful in the initial server output. */
export function IntegrationsSurface({
  providers,
  accounts,
  activity,
  title = "Integrations",
  description = "Connect organization accounts and choose which ones this app uses.",
  providerIds,
  sections,
  state,
  onAction,
  onRefresh,
}: IntegrationsSurfaceProps) {
  const id = useId();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const visibleProviders =
    providerIds === undefined
      ? providers
      : [...new Set(providerIds)].flatMap((key) => {
          const provider = byId.get(key);
          return provider ? [provider] : [];
        });
  // Catalog discovery can fail while independently authorized accounts/activity load.
  const visibleIds = providerIds === undefined ? undefined : new Set(providerIds);
  const visibleAccounts = accounts.filter(
    (account) => !visibleIds || visibleIds.has(account.providerId),
  );
  const visibleActivity = activity.filter(
    (entry) => !visibleIds || visibleIds.has(entry.providerId),
  );
  return (
    <section className="integrations-surface" aria-labelledby={`${id}-title`}>
      <header className="integrations-header">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="integrations-muted">{description}</p>
        </div>
        <IntegrationRefresh onRefresh={onRefresh} />
      </header>
      {sections?.accounts !== false ? (
        <section aria-labelledby={`${id}-accounts`}>
          <h3 id={`${id}-accounts`}>Connected accounts</h3>
          <SectionNotice state={state?.accounts} />
          <div className="integrations-account-list">
            {visibleAccounts.map((account) => (
              <article
                key={account.id}
                className="integrations-card"
                aria-label={`${byId.get(account.providerId)?.name ?? account.providerId}: ${account.label}`}
              >
                <div className="integrations-card__heading">
                  <div>
                    <p className="integrations-muted">
                      {byId.get(account.providerId)?.name ?? account.providerId}
                    </p>
                    <h4>{account.label}</h4>
                  </div>
                  <StatusPill label={account.status.label} tone={account.status.tone} />
                </div>
                {account.status.message ? <p>{account.status.message}</p> : null}
                <div className="integrations-activation">
                  <span>In this app</span>
                  <StatusPill label={account.activation.label} tone={account.activation.tone} />
                </div>
                {account.activation.message ? (
                  <p className="integrations-muted">{account.activation.message}</p>
                ) : null}
                {sections?.health !== false && account.health ? (
                  <Health health={account.health} />
                ) : null}
                <IntegrationActions
                  providerId={account.providerId}
                  accountId={account.id}
                  actions={account.actions}
                  onAction={onAction}
                />
              </article>
            ))}
          </div>
          {visibleAccounts.length === 0 &&
          (!state?.accounts || state.accounts.status === "ready") ? (
            <p className="integrations-muted">
              {sections?.catalog !== false &&
              visibleProviders.some((provider) => provider.connect?.availability === "available")
                ? "No connected accounts yet. Connect an account below to get started."
                : "No connected accounts yet."}
            </p>
          ) : null}
        </section>
      ) : null}
      {sections?.catalog !== false ? (
        <section aria-labelledby={`${id}-catalog`}>
          <h3 id={`${id}-catalog`}>Available integrations</h3>
          <SectionNotice state={state?.catalog} />
          {visibleProviders.length > 0 || !state?.catalog || state.catalog.status === "ready" ? (
            <IntegrationCatalog
              entries={visibleProviders.map((provider) => ({
                id: provider.id,
                searchText: `${provider.name} ${provider.description}`,
                content: (
                  <article className="integrations-card" aria-label={provider.name}>
                    <div className="integrations-card__heading">
                      <h4>{provider.name}</h4>
                      <StatusPill label={provider.status.label} tone={provider.status.tone} />
                    </div>
                    <p>{provider.description}</p>
                    {provider.status.message ? (
                      <p className="integrations-muted">{provider.status.message}</p>
                    ) : null}
                    {provider.connect ? (
                      <IntegrationActions
                        providerId={provider.id}
                        actions={[provider.connect]}
                        onAction={onAction}
                      />
                    ) : null}
                  </article>
                ),
              }))}
            />
          ) : null}
        </section>
      ) : null}
      {sections?.activity !== false ? (
        <section aria-labelledby={`${id}-activity`}>
          <h3 id={`${id}-activity`}>Recent activity</h3>
          <SectionNotice state={state?.activity} />
          <ol className="integrations-activity">
            {visibleActivity.map((entry) => (
              <li key={entry.id}>
                <div>
                  <strong>{entry.title}</strong>
                  <span className="integrations-muted">
                    {byId.get(entry.providerId)?.name ?? entry.providerId}
                    {entry.accountLabel ? ` · ${entry.accountLabel}` : ""}
                  </span>
                  {entry.detail ? <p>{entry.detail}</p> : null}
                </div>
                <span className="integrations-muted">{entry.occurredAt}</span>
              </li>
            ))}
          </ol>
          {visibleActivity.length === 0 &&
          (!state?.activity || state.activity.status === "ready") ? (
            <p className="integrations-muted">No recent integration activity.</p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function SectionNotice({ state }: { state?: IntegrationSectionState }) {
  if (!state || state.status === "ready") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className="integrations-notice">
      {state.status === "loading" ? "Loading integration data…" : state.message}
    </p>
  );
}

function Health({
  health,
}: {
  health: IntegrationStatus & { details?: readonly { label: string; value: string }[] };
}) {
  return (
    <section className="integrations-health" aria-label="Integration health">
      <div className="integrations-card__heading">
        <h5>Integration health</h5>
        <StatusPill label={health.label} tone={health.tone} />
      </div>
      {health.message ? <p>{health.message}</p> : null}
      {health.details?.length ? (
        <dl>
          {health.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
