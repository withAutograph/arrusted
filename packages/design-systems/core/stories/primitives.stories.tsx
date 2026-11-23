import { useState, type CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChevronRight, Plus } from "../icons";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  DropdownMenu,
  FieldFrame,
  Modal,
  Popover,
  Select,
  StatusPill,
  Tabs,
  TextArea,
  TextField,
  Toggle,
  Tooltip,
  Typography,
} from "../components";

const meta = {
  title: "Design System/Primitives",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[960px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <Card title="Buttons">
      <div className="grid gap-[var(--space-4)]">
        <div className="flex flex-wrap gap-[var(--space-2)]">
          <Button intent="primary">Primary</Button>
          <Button intent="secondary">Secondary</Button>
          <Button intent="danger">Danger</Button>
          <Button intent="ghost">Ghost</Button>
        </div>
        <div className="flex flex-wrap gap-[var(--space-2)]">
          <Button size="xs">Extra Small</Button>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </div>
        <div className="flex flex-wrap gap-[var(--space-2)]">
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button
            leading={<Plus className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]" />}
            trailing={<ChevronRight className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]" />}
          >
            With Icons
          </Button>
        </div>
      </div>
    </Card>
  ),
};

export const FormControls: Story = {
  render: () => <FormControlFixture />,
};

export const Display: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <Card
        title="Display"
        actions={
          <Button size="sm" intent="secondary">
            Action
          </Button>
        }
      >
        <div className="grid gap-[var(--space-4)]">
          <div className="flex flex-wrap gap-[var(--space-2)]">
            <Badge>Neutral</Badge>
            <Badge tone="info">Info</Badge>
            <Badge tone="success">Success</Badge>
            <Badge tone="warning">Warning</Badge>
            <Badge tone="danger">Danger</Badge>
          </div>
          <Divider />
          <div className="flex flex-wrap gap-[var(--space-2)]">
            <StatusPill label="Queued" />
            <StatusPill label="Ready" tone="success" detail="3 items" />
            <StatusPill label="Review" tone="warning" />
            <StatusPill label="Blocked" tone="danger" />
          </div>
        </div>
      </Card>
      <TabsFixture />
    </div>
  ),
};

export const TypographyScale: Story = {
  render: () => (
    <Card title="Typography">
      <div className="grid gap-[var(--space-3)]">
        <Typography variant="page-title">Page Title</Typography>
        <Typography variant="section-title">Section Title</Typography>
        <Typography variant="title">Title</Typography>
        <Typography variant="body">Body copy keeps dense surfaces readable.</Typography>
        <Typography variant="body-strong">Emphasized Body Text</Typography>
        <Typography variant="caption" tone="muted">
          Caption text
        </Typography>
        <Typography variant="micro" tone="secondary">
          Micro text
        </Typography>
      </div>
    </Card>
  ),
};

export const Overlays: Story = {
  render: () => <OverlayFixture />,
};

function OverlayFixture() {
  const [modalOpen, setModalOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <Card title="Overlays">
      <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        <Button intent="primary" onClick={() => setModalOpen(true)}>
          Open Modal
        </Button>
        <Popover
          open={popoverOpen}
          trigger={
            <Button
              intent="secondary"
              size="sm"
              onClick={() => setPopoverOpen((current) => !current)}
            >
              Popover
            </Button>
          }
        >
          <div className="w-[220px] text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
            Popovers anchor lightweight controls near the trigger.
          </div>
        </Popover>
        <DropdownMenu
          open={menuOpen}
          trigger={
            <Button intent="secondary" size="sm" onClick={() => setMenuOpen((current) => !current)}>
              Menu
            </Button>
          }
          items={[
            { id: "first", label: "First action", onSelect: () => null },
            { id: "second", label: "Second action", onSelect: () => null },
            { id: "disabled", label: "Disabled action", disabled: true, onSelect: () => null },
          ]}
        />
        <Tooltip content="Helpful detail">
          <Button intent="ghost" size="sm">
            Hover Target
          </Button>
        </Tooltip>
      </div>
      <Modal
        open={modalOpen}
        title="Modal Title"
        description="Modal descriptions clarify the task without owning product semantics."
        onClose={() => setModalOpen(false)}
        actions={
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button intent="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button intent="primary" onClick={() => setModalOpen(false)}>
              Confirm
            </Button>
          </div>
        }
      >
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          This modal uses the real focus trap and close affordances.
        </p>
      </Modal>
    </Card>
  );
}

function FormControlFixture() {
  const [checked, setChecked] = useState(true);
  const [toggleEnabled, setToggleEnabled] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [authorFilter, setAuthorFilter] = useState("anyone");
  const inlineLabel: CSSProperties = {
    fontSize: "var(--text-caption)",
    color: "var(--color-text-muted)",
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
  };
  return (
    <Card title="Form Controls">
      <div className="mb-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-4)]">
        <span className="text-[length:var(--text-caption)] text-[var(--color-text-secondary)]">
          Toolbar pattern (label + Select size="sm"):
        </span>
        <label style={inlineLabel}>
          Category:
          <Select
            size="sm"
            className="w-auto"
            value={typeFilter}
            onValueChange={setTypeFilter}
            options={[
              { value: "all", label: "All" },
              { value: "alpha", label: "Alpha" },
              { value: "beta", label: "Beta" },
              { value: "gamma", label: "Gamma" },
            ]}
          />
        </label>
        <label style={inlineLabel}>
          Owner:
          <Select
            size="sm"
            className="w-auto"
            value={authorFilter}
            onValueChange={setAuthorFilter}
            options={[
              { value: "anyone", label: "Anyone" },
              { value: "me", label: "Me" },
            ]}
          />
        </label>
      </div>
      <div className="grid gap-[var(--space-4)] sm:grid-cols-2">
        <FieldFrame label="Text Field" helper="Helper text lives below the control.">
          <TextField defaultValue="Sample value" placeholder="Enter text" />
        </FieldFrame>
        <FieldFrame label="Required Field" required error="This value needs attention.">
          <TextField defaultValue="" required aria-invalid="true" placeholder="Required value" />
        </FieldFrame>
        <FieldFrame label="Disabled Text">
          <TextField defaultValue="Read only value" disabled />
        </FieldFrame>
        <FieldFrame label="Select">
          <Select
            defaultValue="review"
            options={[
              { value: "draft", label: "Draft" },
              { value: "review", label: "Review" },
              { value: "done", label: "Done" },
            ]}
          />
        </FieldFrame>
        <FieldFrame label="Disabled Select">
          <Select
            defaultValue="done"
            disabled
            options={[
              { value: "draft", label: "Draft" },
              { value: "done", label: "Done" },
            ]}
          />
        </FieldFrame>
        <FieldFrame label="Text Area">
          <TextArea defaultValue="Longer notes fit here." />
        </FieldFrame>
        <FieldFrame label="Disabled Text Area">
          <TextArea defaultValue="Locked notes." disabled />
        </FieldFrame>
        <Checkbox checked={checked} onCheckedChange={setChecked} label="Interactive checkbox" />
        <Checkbox disabled checked={false} onCheckedChange={() => null} label="Disabled checkbox" />
        <Toggle
          checked={toggleEnabled}
          onCheckedChange={setToggleEnabled}
          label="Interactive toggle"
        />
        <Toggle disabled checked={false} onCheckedChange={() => null} label="Disabled toggle" />
      </div>
    </Card>
  );
}

function TabsFixture() {
  const [value, setValue] = useState("overview");
  return (
    <Tabs
      value={value}
      onValueChange={setValue}
      items={[
        { id: "overview", label: "Overview" },
        { id: "details", label: "Details" },
        { id: "activity", label: "Activity" },
        { id: "archived", label: "Archived Records" },
      ]}
    />
  );
}
