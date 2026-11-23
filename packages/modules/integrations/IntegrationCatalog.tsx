"use client";

import { useId, useState, type ReactNode } from "react";
import { FieldFrame, TextField } from "@autograph/components";

/** Cards remain server-rendered children; only filtering hydrates. */
export function IntegrationCatalog({
  entries,
}: {
  entries: readonly { id: string; searchText: string; content: ReactNode }[];
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const matches = entries.map((entry) => entry.searchText.toLocaleLowerCase().includes(term));
  return (
    <div className="integrations-catalog">
      <FieldFrame label="Find an integration" htmlFor={id}>
        <TextField
          id={id}
          type="search"
          value={query}
          onValueChange={setQuery}
          placeholder="Search integrations"
        />
      </FieldFrame>
      <div className="integrations-grid">
        {entries.map((entry, index) => (
          <div key={entry.id} hidden={!matches[index]}>
            {entry.content}
          </div>
        ))}
      </div>
      {!matches.some(Boolean) ? (
        <p role="status">
          {entries.length ? "No integrations match your search." : "No integrations are available."}
        </p>
      ) : null}
    </div>
  );
}
