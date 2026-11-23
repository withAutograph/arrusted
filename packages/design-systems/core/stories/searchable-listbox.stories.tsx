import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, SearchableListbox, type SearchableListboxOption } from "../components";

const projects: readonly SearchableListboxOption<string>[] = [
  { value: "atlas", label: "Atlas", searchText: "Atlas planning" },
  { value: "beacon", label: "Beacon", searchText: "Beacon operations" },
  { value: "cedar", label: "Cedar", searchText: "Cedar archived", disabled: true },
  { value: "delta", label: "Delta", searchText: "Delta research" },
  { value: "ember", label: "Ember", searchText: "Ember customer success" },
  { value: "fjord", label: "Fjord", searchText: "Fjord infrastructure" },
  { value: "grove", label: "Grove", searchText: "Grove design systems" },
  { value: "harbor", label: "Harbor", searchText: "Harbor finance" },
  { value: "indigo", label: "Indigo", searchText: "Indigo analytics" },
  { value: "juno", label: "Juno", searchText: "Juno mobile" },
  { value: "keystone", label: "Keystone", searchText: "Keystone platform" },
  { value: "lumen", label: "Lumen", searchText: "Lumen accessibility" },
];

function Harness(props: {
  loading?: boolean;
  error?: string;
  options?: readonly SearchableListboxOption<string>[];
}) {
  const [query, setQuery] = useState("");
  const [value, setValue] = useState<string | null>(null);
  return (
    <Card title="Project" className="h-[400px] w-[var(--size-editor-popover-md)]">
      <SearchableListbox
        options={props.options ?? projects}
        value={value}
        query={query}
        onQueryChange={setQuery}
        onValueChange={setValue}
        getOptionKey={(optionValue) => optionValue}
        ariaLabel="Project"
        placeholder="Search projects"
        loading={props.loading}
        error={props.error}
      />
    </Card>
  );
}

const meta = {
  title: "Design System/Components/SearchableListbox",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <Harness /> };
export const Loading: Story = { render: () => <Harness loading /> };
export const Empty: Story = { render: () => <Harness options={[]} /> };
export const Error: Story = {
  render: () => <Harness options={[]} error="Projects could not be loaded." />,
};
