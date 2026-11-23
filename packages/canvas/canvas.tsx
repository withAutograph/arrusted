import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import type { WorkTarget } from "@autograph/generated-app-runtime/data";
import { AsOfDatePill, Button, Checkbox, ToastProvider, cx, useToast } from "@autograph/components";
import { Bolt, ClipboardDocumentList, Comment } from "@autograph/icons";
import { createLabelIndex, modelLabel, pluralLabel } from "@autograph/work-session-tools/labels";

import { AddUnitButton, type NewUnit } from "./add-unit";
import { ReviewSurface, ReviewSwitch, useReview, type CanvasMode } from "./review-mode";
import { CanvasPlane, onScreen, type PlaneFocus, type UnitView } from "./canvas-plane";
import { ChartUnit, chartUnitTitle } from "./chart-unit";
import { ChartFilters } from "./unit-filters";
import { withPendingDrafts, type CanvasClient, type CanvasDrafts } from "./client";
import {
  CommentModeProvider,
  nextThreadId,
  ThreadPin,
  threadCellPin,
  threadAnchor,
  threadsOn,
  useCommentMode,
  type ThreadAnchor,
} from "./comment-mode";
import { SessionDraftThreads, useSessionDrafts } from "./draft-threads";
import { GraphUnit, graphUnitTitle } from "./graph-unit";
import { GridUnit, type GridReveal } from "./grid-unit";
import { KpiUnit, kpiUnitTitle } from "./kpi-unit";
import { NoteUnit } from "./note-unit";
import { SessionsMenu } from "./sessions-menu";
import { addUnit, type CanvasLayout, type CanvasUnit } from "@autograph/work-session-tools/layout";
import { useAddedUnits, useOutsideChanges } from "./outside-changes";
import { RecordDrawer } from "./record-panel";
import { threadRefs, useRecordNames } from "./record-names";
import { RuleCard, ruleTitle } from "./rule-card";
import { SaveBar } from "./save-bar";
import {
  createSelectionStore,
  presenceTargets,
  createPresenceWriter,
  selectionOutdated,
  type CanvasSelection,
  type SelectionStore,
} from "./selection";
import { entryKey, StagedLog } from "./staged-log";
import { ThreadPopover, threadPlace } from "./thread-popover";
import type { CanvasThread } from "./threads";
import { PaneButton, PaneHeader, PaneList, useArrivalPulse } from "./top-bar-pane";
import { useCanvasSession, type CanvasOutcome, type CanvasSession } from "./use-canvas-session";
import type { DraftReviewController } from "@modules/draft-review";

export type CanvasProps = {
  client: CanvasClient;
  sessionId: string;
  /** Hears every selection, e.g. to pass it to the agent. */
  onSelectionChange?: (selection: CanvasSelection | null) => void;
  /** The host's own controls at the end of the top bar (e.g. a chat's Full screen). */
  headerActions?: ReactNode;
  /**
   * A chat's inline canvas: one bar keeps the title, as-of, what is
   * unsaved and Save (Review, Comments, Add to canvas and the other panes
   * wait for full screen), and the plane is as tall as its units.
   */
  compact?: boolean;
};

/** The model a unit shows, from its config. */
export function unitModelId(unit: CanvasUnit): string | null {
  const model = unit.config.model_id;
  return typeof model === "string" ? model : null;
}

const failureText = (outcome: Extract<CanvasOutcome, { ok: false }>) =>
  outcome.code === "outcome_unknown"
    ? "We couldn't confirm that. The canvas shows the session as it is now."
    : outcome.code === "revision_conflict"
      ? "The session changed meanwhile. The canvas shows it as it is now; try again."
      : outcome.message;

/**
 * The working-session canvas a host mounts over its client: the session's
 * units and rule cards on the plane, the impact line, and a top bar whose
 * panes hold what is staged, the open comments and the rules, then Save.
 * Threads open in place beside what they are pinned to; records open in a
 * drawer; changes from outside the canvas are announced as toasts.
 * Everything shown is session state except the view (zoom, selection, open
 * panes).
 */
export function Canvas(props: CanvasProps) {
  return (
    <ToastProvider>
      <CanvasBody {...props} />
    </ToastProvider>
  );
}

function CanvasBody({
  client,
  sessionId,
  onSelectionChange,
  headerActions,
  compact = false,
}: CanvasProps) {
  const session = useCanvasSession(client, sessionId);
  // A new session starts with no selection.
  const store = useMemo(
    () => createSelectionStore(client.definition),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- sessionId resets the store.
    [client.definition, sessionId],
  );
  const toast = useToast();
  const [openThread, setOpenThread] = useState<string | null>(null);
  // View state, never saved: every unit reads pending drafts over mainline
  // (under the staged values) unless the person turns them off.
  const [showDrafts, setShowDrafts] = useState(true);
  const reads = useMemo(() => withPendingDrafts(client, showDrafts), [client, showDrafts]);

  // The person's selection, as presence the agent reads: debounced, at most
  // 200 targets, and only what names records (a chart bar names none).
  const writePresence = useRef(session.presence);
  writePresence.current = session.presence;
  const [presenceWriter, setPresenceWriter] = useState<ReturnType<
    typeof createPresenceWriter
  > | null>(null);
  useEffect(() => {
    // Each writer is bound to its session; switching drops its queued work.
    const forSession = sessionId;
    const writer = createPresenceWriter((targets) => writePresence.current(targets, forSession));
    writer.next(presenceTargets(store.getSnapshot().selection));
    const unsubscribe = store.subscribe(() =>
      writer.next(presenceTargets(store.getSnapshot().selection)),
    );
    setPresenceWriter(writer);
    return () => {
      writer.dispose();
      unsubscribe();
    };
  }, [store, sessionId]);
  // Once this session is read, what its presence holds is known (a reopened
  // canvas may find an old selection there): the current one replaces it.
  const storedPresence =
    session.session?.id === sessionId ? (session.session.presence?.selection ?? []) : null;
  useEffect(() => {
    if (presenceWriter !== null && storedPresence !== null) presenceWriter.known(storedPresence);
  }, [presenceWriter, storedPresence]);

  useEffect(() => {
    if (onSelectionChange === undefined) return;
    // A new store (a new session) starts empty: the host hears that too.
    onSelectionChange(store.getSnapshot().selection);
    const unsubscribe = store.subscribe(() => onSelectionChange(store.getSnapshot().selection));
    return () => {
      unsubscribe();
    };
  }, [store, onSelectionChange]);

  if (session.session === null)
    return (
      <div className="flex h-full min-h-[var(--space-0)] flex-1 items-center justify-center bg-[var(--color-bg-page)] p-[var(--space-6)] font-[var(--font-sans)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        {session.status === "error" ? (
          <div className="flex flex-col items-center gap-[var(--space-3)]" role="alert">
            <span>This session could not be loaded.</span>
            <Button intent="secondary" size="sm" onClick={() => void session.reload()}>
              Try again
            </Button>
          </div>
        ) : (
          <span role="status">Loading session…</span>
        )}
      </div>
    );

  return (
    <CommentModeProvider
      threadOpen={session.threadOpen}
      onFailed={(outcome) => toast.warning(`The thread was not opened. ${failureText(outcome)}`)}
      onOpened={setOpenThread}
    >
      {client.drafts === undefined ? (
        <CanvasView
          client={reads}
          openThread={openThread}
          showDrafts={showDrafts}
          onShowDraftsChange={setShowDrafts}
          review={null}
          session={session}
          headerActions={headerActions}
          compact={compact}
          setOpenThread={setOpenThread}
          store={store}
        />
      ) : (
        <ReviewingCanvasView
          client={reads}
          drafts={client.drafts}
          showDrafts={showDrafts}
          onShowDraftsChange={setShowDrafts}
          openThread={openThread}
          session={session}
          setOpenThread={setOpenThread}
          headerActions={headerActions}
          compact={compact}
          store={store}
        />
      )}
    </CommentModeProvider>
  );
}

type Opened = { modelId: string; recordId: string };
type Pane = "staged" | "comments" | "rules";

/**
 * A top-bar action's label in a narrow bar (a chat panel, a split window):
 * hidden, so Comments and Add to canvas are icons that keep their names and
 * titles, and the bar fits without scrolling.
 */
const narrowHidden = "@max-[53rem]/top-bar:hidden";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A CSS attribute selector for one value. */
const is = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`;
/** An entry's cell on a table. */
const cellOf = (entry: WorkTarget) =>
  `${is("row-id", entry.record_id)} ${is("col-id", entry.field_id)}`;
/** Open popovers, menus and in-cell editors, wherever they are portaled. */
const openOverlays =
  "[role='dialog'], [role='menu'], [role='listbox'], .ag-popup, .ag-cell-inline-editing, .ag-popup-editor";

/** The models the session's units show, in layout order. */
const sessionModelIds = (units: readonly CanvasUnit[]) => [
  ...new Set(units.map(unitModelId).filter((id): id is string => id !== null)),
];

type ViewProps = {
  client: CanvasClient;
  session: CanvasSession;
  store: SelectionStore;
  openThread: string | null;
  setOpenThread: Dispatch<SetStateAction<string | null>>;
  headerActions?: ReactNode;
  compact?: boolean;
  /** Whether units read pending drafts (the header's Show drafts). */
  showDrafts: boolean;
  onShowDraftsChange: (showDrafts: boolean) => void;
};

/**
 * The canvas with Review mode, for every member: the review controller lives
 * here, so the bell counts in Work mode too.
 */
function ReviewingCanvasView(props: ViewProps & { drafts: CanvasDrafts }) {
  const units = props.session.layout.units;
  const modelIds = useMemo(() => sessionModelIds(units), [units]);
  const controller = useReview(props.client, props.drafts, props.session.session!.id, modelIds);
  return <CanvasView {...props} review={{ drafts: props.drafts, controller }} />;
}

function CanvasView({
  client,
  session,
  store,
  openThread,
  setOpenThread,
  review,
  headerActions,
  compact = false,
  showDrafts,
  onShowDraftsChange,
}: ViewProps & {
  /** Review mode's review, for every member when the client has drafts. */
  review: { drafts: CanvasDrafts; controller: DraftReviewController } | null;
}) {
  const header = session.session!;
  const toast = useToast();
  const labels = useMemo(() => createLabelIndex(client.definition), [client.definition]);
  const [record, setRecord] = useState<Opened | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  /** Where the Save bar shows the agent's request to Save: under the top bar. */
  const [requestSlot, setRequestSlot] = useState<HTMLDivElement | null>(null);
  /** Entries the Staged changes pane marks, e.g. the ones a toast's View named. */
  const [stagedFocus, setStagedFocus] = useState<readonly WorkTarget[] | null>(null);
  /** Save stopped at this revision to show these entries, which nothing on the canvas shows. */
  const [hidden, setHidden] = useState<{ revision: number; entries: readonly WorkTarget[] } | null>(
    null,
  );
  const [focus, setFocus] = useState<PlaneFocus | null>(null);
  /** Each mounted grid unit's `reveal`, by unit id. */
  const reveals = useRef(new Map<string, GridReveal>());
  const onReveal = useCallback((unitId: string, reveal: GridReveal | null) => {
    if (reveal === null) reveals.current.delete(unitId);
    else reveals.current.set(unitId, reveal);
  }, []);
  const root = useRef<HTMLDivElement | null>(null);
  const centre = useRef<HTMLDivElement | null>(null);
  const topBar = useRef<HTMLElement | null>(null);
  const changesBar = useRef<HTMLDivElement | null>(null);
  const units = session.layout.units;
  // A unit whose query changed (the agent's update_unit, or a new config) no
  // longer shows what was selected in it: its selection stops filtering.
  const unitConfigs = JSON.stringify(units.map((unit) => [unit.id, unit.config]));
  const seenConfigs = useRef<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    const now = new Map(units.map((unit) => [unit.id, JSON.stringify(unit.config)]));
    if (selectionOutdated(store.getSnapshot().selection, seenConfigs.current, now))
      store.select(null);
    seenConfigs.current = now;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the configs' content.
  }, [unitConfigs, store]);
  /** Review mode swaps the plane for the review; the plane stays mounted, so Work comes back as it was. */
  const [mode, setMode] = useState<CanvasMode>("work");
  // A compact (inline chat) canvas has no Review switch, so it always shows Work.
  const reviewing = review !== null && mode === "review" && !compact;
  /**
   * The record drawer starts below the canvas header (the top bar and the
   * plane's impact strip under it), so Save and the strip stay in reach. It
   * follows the header when it wraps or the window resizes.
   */
  const [drawerTop, setDrawerTop] = useState<string | undefined>(undefined);
  const drawerOpen = record !== null;
  useLayoutEffect(() => {
    const bar = topBar.current;
    if (!drawerOpen || bar === null) return;
    const strip = root.current?.querySelector<HTMLElement>("[data-canvas-toolbar]") ?? null;
    const changes = changesBar.current;
    const measure = () => {
      const bottom = Math.max(
        bar.getBoundingClientRect().bottom,
        changes?.getBoundingClientRect().bottom ?? 0,
        strip?.getBoundingClientRect().bottom ?? 0,
      );
      setDrawerTop(`${bottom}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (changes !== null) observer.observe(changes);
    if (strip !== null) observer.observe(strip);
    return () => observer.disconnect();
    // The changes strip mounts and unmounts with compact (full screen) and
    // Review: measure whichever bars are there then too.
  }, [drawerOpen, compact, reviewing]);
  const reviewController = review?.controller ?? null;
  /**
   * The Review tab's count: drafts waiting on this viewer. An approver's are the pending
   * drafts they may approve; a member's are their own drafts still pending.
   */
  const waitingDrafts =
    review === null
      ? 0
      : review.drafts.canApprove
        ? review.controller.pendingDrafts
        : [...review.controller.pendingAuthors.values()].filter(
            (author) => author === header.owner_id,
          ).length;
  const changeMode = (next: CanvasMode) => {
    if (next === "review" && mode !== "review") {
      setPane(null);
      void reviewController?.reload();
    }
    setMode(next);
  };
  const sessionDrafts = useSessionDrafts(client, client.drafts, header.id);
  const recordName = useRecordNames(
    client,
    session,
    threadRefs(client.definition, session.threads),
  );
  /** A pin steps through its open threads, one per click. */
  const openNext = useCallback(
    (on: readonly CanvasThread[]) => setOpenThread((open) => nextThreadId(on, open)),
    [setOpenThread],
  );
  const openThreads = session.threads.filter((item) => !item.resolved);

  const unitTitle = (unit: CanvasUnit) => {
    if (unit.title !== undefined) return unit.title;
    if (unit.kind === "chart") return chartUnitTitle(client, unit.config);
    if (unit.kind === "kpi") return kpiUnitTitle(client, unit.config);
    if (unit.kind === "note") return "Note";
    if (unit.kind === "graph") return graphUnitTitle(client, unit.config);
    if (unit.kind === "rule") {
      const rule = session.rules.find((item) => item.id === unit.config.rule_id);
      return rule === undefined ? "Rule" : ruleTitle(client.definition, rule);
    }
    const model = labels.modelById(unitModelId(unit) ?? "");
    return model === undefined ? "Table" : pluralLabel(modelLabel(model));
  };
  const titleOf = (id: string) => {
    const unit = units.find((item) => item.id === id);
    return unit === undefined ? undefined : unitTitle(unit);
  };
  /** Where a thread is, in one line: the record and column when it has them, else the unit. */
  const placeOf = (thread: CanvasThread) => {
    const place = threadPlace(thread, client.definition, recordName, titleOf);
    return place.scope ?? place.surface;
  };

  /** Units the canvas added itself: the person's adds and the rule cards it places. */
  const ownUnits = useRef(new Set<string>());
  const markOwn = (before: CanvasLayout, after: CanvasLayout) => {
    const had = new Set(before.units.map((unit) => unit.id));
    for (const unit of after.units) if (!had.has(unit.id)) ownUnits.current.add(unit.id);
    return after;
  };
  useRulesOnPlane(
    session,
    (outcome) => toast.warning(`The rule card was not placed. ${failureText(outcome)}`),
    markOwn,
  );

  const openPane = (next: Pane | null, entries: readonly WorkTarget[] | null = null) => {
    setPane(next);
    setStagedFocus(entries);
  };
  /**
   * Whether the canvas shows an entry: a table has its record loaded and its
   * column displayed, or the open record drawer shows that record.
   */
  const shown = (entry: WorkTarget) =>
    (record !== null && record.modelId === entry.model_id && record.recordId === entry.record_id) ||
    units.some(
      (unit) =>
        unit.kind === "grid" &&
        unitModelId(unit) === entry.model_id &&
        reveals.current.get(unit.id)?.(entry.record_id, entry.field_id, { scroll: false }) === true,
    );
  /**
   * Save first lists staged changes nothing on the canvas shows; Save again
   * at the same revision saves them all.
   */
  const beforeSave = (revision: number) => {
    if (hidden?.revision === revision) return true;
    const unseen = session.entries.filter((entry) => !shown(entry));
    if (unseen.length === 0) return true;
    setPane("staged");
    setStagedFocus(unseen);
    setHidden({ revision, entries: unseen });
    return false;
  };
  /** The grid units that have an entry's record loaded and its column displayed. */
  const gridsWith = (entry: WorkTarget) =>
    units.filter(
      (unit) =>
        unit.kind === "grid" &&
        unitModelId(unit) === entry.model_id &&
        reveals.current.get(unit.id)?.(entry.record_id, entry.field_id, { scroll: false }) === true,
    );
  const planeViewport = () =>
    root.current?.querySelector<HTMLElement>("[data-canvas-plane] [role='region']") ?? null;
  /** Whether the person can see an entry now: its cell on screen in a table, or its record in the drawer. */
  const onScreenNow = (entry: WorkTarget) => {
    if (record !== null && record.modelId === entry.model_id && record.recordId === entry.record_id)
      return true;
    const viewport = planeViewport();
    return gridsWith(entry).some((unit) => {
      const cell = root.current?.querySelector<HTMLElement>(
        `${is("data-unit-box", unit.id)} ${cellOf(entry)}`,
      );
      return (
        cell !== null &&
        cell !== undefined &&
        onScreen(
          cell,
          viewport,
          cell.closest(".ag-body-viewport"),
          cell.closest(".ag-center-cols-viewport"),
        )
      );
    });
  };
  /**
   * Mid-gesture: moving or resizing a unit, typing on the canvas, editing a
   * cell, or a pane, popover or menu open. The canvas is not scrolled then.
   */
  const busy = () => {
    const at = root.current;
    if (at === null) return true;
    if (pane !== null || openThread !== null) return true;
    if (at.querySelector("[data-canvas-gesture]") !== null) return true;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      at.contains(active) &&
      (active.isContentEditable || active.matches("input, textarea, select"))
    )
      return true;
    // A canvas inside a dialog (an inline chat) is not covered by it.
    return [...document.querySelectorAll(openOverlays)].some((overlay) => !overlay.contains(at));
  };
  /**
   * An agent turn's staged values: the first a table has loaded is brought
   * into view (unless it is already on screen) and every loaded one flashes.
   * Mid-gesture, a toast offers View instead; values no table shows get a
   * toast whose View opens the log at them.
   */
  const followAgentStaged = (entries: readonly WorkTarget[]) => {
    if (busy()) {
      toast.info(`Agent changed ${plural(entries.length, "value")}`, {
        action: { label: "View", onClick: () => viewChanges(entries) },
      });
      return;
    }
    const loaded = entries.filter((entry) => gridsWith(entry).length > 0);
    const first = loaded[0];
    if (first !== undefined) {
      // Scroll unless the change it focuses is itself on screen.
      const visible = onScreenNow(first);
      const unit = gridsWith(first)[0]!;
      if (!visible) reveals.current.get(unit.id)?.(first.record_id, first.field_id);
      setFocus((last) => ({
        unitId: unit.id,
        flash: cellOf(first),
        also: loaded.slice(1).map(cellOf),
        scroll: !visible,
        nonce: (last?.nonce ?? 0) + 1,
      }));
    }
    const unshown = entries.filter(
      (entry) =>
        !loaded.includes(entry) &&
        !(
          record !== null &&
          record.modelId === entry.model_id &&
          record.recordId === entry.record_id
        ),
    );
    if (unshown.length > 0)
      toast.info(`Agent changed ${plural(unshown.length, "value")}`, {
        action: { label: "View", onClick: () => openPane("staged", unshown) },
      });
  };
  /** Units an agent added: one off screen is brought into view; each flashes. */
  useAddedUnits(
    header.id,
    units.map((unit) => unit.id),
    ownUnits.current,
    (added) => {
      const [first] = added;
      if (first === undefined) return;
      const box = () =>
        root.current?.querySelector<HTMLElement>(is("data-unit-box", first)) ?? null;
      const focusOn = (scroll: boolean) =>
        setFocus((last) => ({ unitId: first, scroll, nonce: (last?.nonce ?? 0) + 1 }));
      if (busy()) {
        toast.info(
          added.length === 1 ? "Agent added a unit" : `Agent added ${added.length} units`,
          {
            action: { label: "View", onClick: () => focusOn(true) },
          },
        );
        return;
      }
      const shownBox = box();
      focusOn(!(shownBox !== null && onScreen(shownBox, planeViewport())));
    },
  );
  useOutsideChanges(
    header.id,
    { entries: session.entries, threads: session.threads },
    (changes) => {
      for (const change of changes) {
        if (change.kind === "agent_staged") followAgentStaged(change.entries);
        else if (change.kind === "changed_underneath")
          toast.warning(
            `Someone else changed ${plural(change.entries.length, "value")} you have not saved yet`,
            { action: { label: "Review", onClick: () => openPane("staged", change.entries) } },
          );
        else {
          // The open thread's popover already shows its new reply or proposal.
          if (change.thread_id === openThread) continue;
          const thread = session.threads.find((item) => item.id === change.thread_id);
          if (thread === undefined) continue;
          toast.info(
            `Agent ${change.kind === "agent_proposed" ? "proposed changes" : "replied"} on ${placeOf(thread)}`,
            {
              action: {
                label: "Open",
                onClick: () => {
                  setPane(null);
                  setOpenThread(change.thread_id);
                },
              },
            },
          );
        }
      }
    },
  );

  /**
   * Shows a staged entry's cell on a table that has its record loaded and
   * shown (scrolled to it), else its record in the drawer.
   */
  const showEntry = (entry: WorkTarget) => {
    setPane(null);
    const unit = units.find(
      (item) =>
        item.kind === "grid" &&
        unitModelId(item) === entry.model_id &&
        reveals.current.get(item.id)?.(entry.record_id, entry.field_id) === true,
    );
    if (unit === undefined) {
      setRecord({ modelId: entry.model_id, recordId: entry.record_id });
      return;
    }
    setFocus((last) => ({
      unitId: unit.id,
      flash: cellOf(entry),
      nonce: (last?.nonce ?? 0) + 1,
    }));
  };
  /** The first of `entries` a table shows, scrolled to and flashed; else the staged log at them. */
  const viewChanges = (entries: readonly WorkTarget[]) => {
    const first = entries.find((entry) => gridsWith(entry).length > 0);
    if (first === undefined) openPane("staged", entries);
    else showEntry(first);
  };
  const showRule = (ruleId: string) => {
    setPane(null);
    const unit = units.find((item) => item.kind === "rule" && item.config.rule_id === ruleId);
    if (unit !== undefined)
      setFocus((last) => ({ unitId: unit.id, zoom: true, nonce: (last?.nonce ?? 0) + 1 }));
  };

  const add = async (next: NewUnit) => {
    const id = `unit-${crypto.randomUUID().slice(0, 8)}`;
    // When the canvas says the saved layout can't be read, a new one holds this unit.
    const outcome = await session.commitLayout(
      (current) => markOwn(current, addUnit(current, next.kind, next.config, id)),
      { startOver: session.layoutError !== null },
    );
    if (!outcome.ok) toast.warning(`That was not added to the canvas. ${failureText(outcome)}`);
  };
  const onLayoutSaved = (
    outcome: CanvasOutcome,
    change: "move" | "resize" | "remove",
    unit: CanvasUnit,
  ) => {
    if (change === "remove" && outcome.ok && store.getSnapshot().selection?.unit_id === unit.id)
      store.select(null);
    if (!outcome.ok)
      toast.warning(
        `${change === "remove" ? "The unit was not removed" : "The layout was not saved"}. ${failureText(outcome)}`,
      );
  };
  const onThreadOutcome = (outcome: CanvasOutcome) => {
    if (!outcome.ok && outcome.code !== "proposal_changed") toast.warning(failureText(outcome));
  };

  const view = (unit: CanvasUnit): UnitView => {
    const title = unitTitle(unit);
    const open = threadsOn(session.threads, { unit_id: unit.id });
    const pins = <ThreadPin count={open.length} target={title} onOpen={() => openNext(open)} />;
    if (unit.kind === "note")
      return {
        title,
        pins,
        content: (
          <NoteUnit
            config={unit.config}
            unitId={unit.id}
            onSave={(text) =>
              void session
                .commitLayout((current) => ({
                  ...current,
                  units: current.units.map((item) =>
                    item.id === unit.id ? { ...item, config: { ...item.config, text } } : item,
                  ),
                }))
                .then((outcome) => {
                  if (!outcome.ok) toast.warning(`The note was not saved. ${failureText(outcome)}`);
                })
            }
          />
        ),
      };
    if (unit.kind === "rule") {
      const rule = session.rules.find((item) => item.id === unit.config.rule_id);
      return {
        title,
        pins,
        // The rule's Remove takes its card with it.
        removable: rule === undefined,
        content:
          rule === undefined ? null : (
            <RuleCard
              definition={client.definition}
              inUnit
              rule={rule}
              session={session}
              onOutcome={(outcome, action) => {
                if (outcome.ok && action === "remove")
                  toast.success("Removed the rule and the changes it made");
              }}
            />
          ),
      };
    }
    return {
      title,
      pins,
      // A chart's header filters, stored in its config.
      controls:
        unit.kind === "chart" ? (
          <ChartFilters
            client={client}
            config={unit.config}
            session={session}
            unitLabel={title}
            onChange={(filters) =>
              void session
                .commitLayout((current) => ({
                  ...current,
                  units: current.units.map((item) =>
                    item.id === unit.id ? { ...item, config: { ...item.config, filters } } : item,
                  ),
                }))
                .then((outcome) => {
                  if (!outcome.ok)
                    toast.warning(`The filter was not saved. ${failureText(outcome)}`);
                })
            }
          />
        ) : undefined,
      content: (
        <UnitContent
          client={client}
          session={session}
          store={store}
          unit={unit}
          onOpenRecord={setRecord}
          onOpenThread={openNext}
          onReveal={onReveal}
        />
      ),
    };
  };

  const thread = session.threads.find((item) => item.id === openThread) ?? null;
  const threadAnchorRef = useThreadAnchor(thread, root, centre);
  const pulse = useArrivalPulse(session.entries.length, pane === "staged");
  const paneOpen = (id: Pane) => (open: boolean) => openPane(open ? id : null);
  const commentMode = useCommentMode();
  /** What is unsaved, as a pill that opens the log of those changes. */
  const changesPane = (
    <PaneButton
      count={session.stagedCount}
      icon={ClipboardDocumentList}
      id="staged"
      label="Unsaved changes"
      open={pane === "staged"}
      pill={
        session.stagedCount === 0
          ? "No unsaved changes"
          : plural(session.stagedCount, "unsaved change")
      }
      pulse={pulse}
      onOpenChange={paneOpen("staged")}
    >
      <StagedLog
        client={client}
        focus={stagedFocus}
        impact
        hidden={
          hidden?.revision === session.revision
            ? session.entries.filter((entry) =>
                hidden.entries.some((item) => entryKey(item) === entryKey(entry)),
              ).length
            : 0
        }
        session={session}
        onShow={showEntry}
      />
    </PaneButton>
  );
  const saveBar = (
    <SaveBar
      beforeSave={beforeSave}
      requestSlot={requestSlot}
      client={client}
      session={session}
      onSaved={() => {
        setHidden(null);
        void sessionDrafts.reload();
      }}
    />
  );
  return (
    <div
      className="relative flex h-full min-h-[var(--space-0)] w-full flex-1 flex-col bg-[var(--color-bg-page)] font-[var(--font-sans)]"
      data-canvas
      ref={root}
    >
      <header
        className="@container/top-bar flex h-[var(--size-control-lg)] shrink-0 items-center gap-[var(--space-3)] overflow-x-auto overflow-y-hidden border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-3)] shadow-[var(--shadow-control)]"
        data-top-bar
        ref={topBar}
      >
        {/*
          The left items sit in the bar itself, so the title is the one that
          gives way and the bar scrolls only once it is at its minimum.
        */}
        <div className="contents">
          {/*
            The title keeps a few words in a narrow window and at most a quarter
            of the bar in a wide one, so a long title truncates instead of
            pushing the date and actions out of the bar.
          */}
          <span className="flex min-w-[calc(var(--space-8)*3)] max-w-[25cqi] items-center">
            {client.sessions === undefined || compact ? (
              <h1 className="m-[var(--space-0)] min-w-[var(--space-0)] truncate px-[var(--space-2)] text-[length:var(--text-control-sm)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
                {header.title}
              </h1>
            ) : (
              <SessionsMenu
                client={client}
                current={{ id: header.id, title: header.title }}
                sessions={client.sessions}
              />
            )}
          </span>
          <span className="inline-flex shrink-0" data-as-of={header.as_of}>
            <AsOfDatePill
              size="sm"
              value={header.as_of.slice(0, 10)}
              onValueChange={(next) => {
                if (next === header.as_of.slice(0, 10)) return;
                void session.setAsOf(next).then((outcome) => {
                  if (!outcome.ok)
                    toast.warning(`The date was not changed. ${failureText(outcome)}`);
                });
              }}
            />
          </span>
          {compact ? null : (
            <span
              className="inline-flex shrink-0 whitespace-nowrap"
              data-show-drafts={showDrafts ? "on" : "off"}
              title={
                showDrafts
                  ? "Showing saved drafts that wait for approval"
                  : "Showing published data only"
              }
            >
              <Checkbox
                checked={showDrafts}
                className="[&>span]:text-[length:var(--text-control-sm)]"
                label="Show drafts"
                onCheckedChange={onShowDraftsChange}
              />
            </span>
          )}
          {review === null || compact ? null : (
            <span className="inline-flex shrink-0">
              <ReviewSwitch mode={mode} pending={waitingDrafts} onModeChange={changeMode} />
            </span>
          )}
        </div>
        <div className="ml-auto flex min-w-[var(--space-0)] shrink-0 items-center gap-[var(--space-2)]">
          {session.error === null ? null : (
            <span
              className="inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-status-warning-ink)]"
              data-refresh-error
              role="status"
            >
              Not up to date.
              <Button intent="ghost" size="xs" onClick={() => void session.reload()}>
                Try again
              </Button>
            </span>
          )}
          {compact ? (
            // A chat's inline canvas keeps what is unsaved and Save in its one bar.
            <span className="flex items-center gap-[var(--space-2)]" data-panes>
              {changesPane}
              {saveBar}
            </span>
          ) : reviewing ? null : (
            <>
              <span className="flex items-center" data-panes>
                <PaneButton
                  count={openThreads.length + sessionDrafts.open}
                  data={{ "data-comment-mode": commentMode.on ? "on" : "off" }}
                  icon={Comment}
                  id="comments"
                  label="Comments"
                  labelClassName={narrowHidden}
                  labelled
                  open={pane === "comments"}
                  pressed={{
                    on: commentMode.on,
                    title: "Click something to comment on it",
                    onRelease: () => commentMode.setOn(false),
                  }}
                  onOpenChange={(open) => {
                    if (open) void sessionDrafts.reload();
                    openPane(open ? "comments" : null);
                  }}
                >
                  <PaneHeader count={openThreads.length + sessionDrafts.open} title="Comments" />
                  <div className="border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
                    <Button
                      className="w-full"
                      data-add-comment
                      intent="primary"
                      leading={<Comment aria-hidden className="size-[var(--size-icon-sm)]" />}
                      size="sm"
                      onClick={() => {
                        setPane(null);
                        commentMode.setOn(true);
                      }}
                    >
                      Add a comment
                    </Button>
                  </div>
                  <div className="min-h-[var(--space-0)] overflow-y-auto">
                    <PaneList
                      empty="No open comments. Choose Add a comment, then click a cell, row or unit."
                      items={openThreads.map((item) => ({
                        key: item.id,
                        title: placeOf(item),
                        detail:
                          item.proposal === undefined
                            ? (item.messages.at(-1)?.message ?? "No messages yet")
                            : "Has a proposal to review",
                        onChoose: () => {
                          setPane(null);
                          // A session thread opens on the plane.
                          setMode("work");
                          setOpenThread(item.id);
                        },
                      }))}
                      label="Open comments"
                    />
                    {client.drafts === undefined ? null : (
                      <SessionDraftThreads
                        client={client}
                        drafts={client.drafts}
                        saved={sessionDrafts.saved}
                        session={session}
                        unitTitle={titleOf}
                        onChanged={sessionDrafts.reload}
                      />
                    )}
                  </div>
                </PaneButton>
              </span>
              <AddUnitButton
                definition={client.definition}
                labelClassName={narrowHidden}
                onAdd={(next) => void add(next)}
              />
            </>
          )}
          {headerActions}
        </div>
      </header>
      {compact || reviewing ? null : (
        // What is unsaved and Save, always shown in Work so the plane never
        // moves when the first change arrives.
        <div
          className="flex h-[var(--size-control-md)] shrink-0 items-center gap-[var(--space-2)] overflow-x-auto overflow-y-hidden border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-3)]"
          data-changes-bar
          ref={changesBar}
        >
          <span className="flex items-center gap-[var(--space-1)]" data-panes>
            {changesPane}
            {session.rules.length === 0 && pane !== "rules" ? null : (
              <PaneButton
                count={session.rules.length}
                icon={Bolt}
                id="rules"
                label="Rules"
                open={pane === "rules"}
                pill={
                  session.rules.length === 0 ? "No rules" : plural(session.rules.length, "rule")
                }
                onOpenChange={paneOpen("rules")}
              >
                <PaneHeader count={session.rules.length} title="Rules" />
                <PaneList
                  empty="No rules yet. A rule sets a column for every record that matches it."
                  items={session.rules.map((rule) => ({
                    key: rule.id,
                    title: ruleTitle(client.definition, rule),
                    detail: `${labels.modelLabel(rule.model_id)} · ${rule.author_kind === "agent" ? "by the agent" : "by you"}`,
                    onChoose: () => showRule(rule.id),
                  }))}
                  label="Rules on the canvas"
                />
              </PaneButton>
            )}
          </span>
          <div className="ml-auto flex shrink-0 items-center">{saveBar}</div>
        </div>
      )}
      {/* The agent's request to Save, over the plane under the bars (the Save bar renders it): it never moves the canvas. */}
      <div
        className={cx(
          "absolute inset-x-[var(--space-0)] z-[var(--z-popover)] shadow-[var(--shadow-raised)] empty:hidden",
          compact
            ? "top-[var(--size-control-lg)]"
            : "top-[calc(var(--size-control-lg)+var(--size-control-md))]",
        )}
        data-save-request-slot
        ref={setRequestSlot}
      />
      <div
        className={
          reviewing
            ? "hidden"
            : compact
              ? "flex w-full flex-col"
              : "flex min-h-[var(--space-0)] w-full flex-1 flex-col"
        }
        data-work-plane
      >
        <CanvasPlane
          empty={
            <EmptyCanvas layoutError={session.layoutError}>
              <AddUnitButton
                definition={client.definition}
                intent="primary"
                onAdd={(next) => void add(next)}
              />
            </EmptyCanvas>
          }
          compact={compact}
          focus={focus}
          session={session}
          view={view}
          onLayoutSaved={onLayoutSaved}
        />
      </div>
      {review === null || !reviewing ? null : (
        <ReviewSurface
          client={client}
          controller={review.controller}
          drafts={review.drafts}
          session={session}
        />
      )}
      {/* Where a thread with nothing on screen to sit beside opens: centred over the plane. */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-1/2 top-1/4 h-[var(--space-0)] w-[min(var(--size-editor-popover-md),calc(100vw-var(--space-4)))] -translate-x-1/2"
        ref={centre}
      />
      <ThreadPopover
        anchorRef={threadAnchorRef}
        definition={client.definition}
        recordName={recordName}
        session={session}
        thread={thread}
        unitTitle={titleOf}
        onClose={() => setOpenThread(null)}
        onOutcome={onThreadOutcome}
      />
      {record === null ? null : (
        <RecordDrawer
          client={client}
          modelId={record.modelId}
          recordId={record.recordId}
          session={session}
          top={drawerTop}
          onClose={() => setRecord(null)}
        />
      )}
    </div>
  );
}

/**
 * What the thread popover opens beside: the thread's cell, row or unit header
 * on the plane when it is on screen as the popover opens, else the centred
 * placeholder. The element is looked up afresh each time the popover places
 * itself, so a grid that re-renders its cells keeps the popover beside them.
 */
function useThreadAnchor(
  thread: CanvasThread | null,
  root: RefObject<HTMLDivElement | null>,
  centre: RefObject<HTMLDivElement | null>,
): RefObject<HTMLElement | null> {
  const id = thread?.id ?? null;
  const anchor = thread === null ? null : JSON.stringify(threadAnchor(thread));
  return useMemo(() => {
    const place = anchor === null ? {} : (JSON.parse(anchor) as ThreadAnchor);
    const find = (): HTMLElement | null => {
      const plane = root.current?.querySelector<HTMLElement>("[data-canvas-plane]");
      if (plane === null || plane === undefined) return null;
      const units =
        place.unit_id === undefined
          ? [...plane.querySelectorAll<HTMLElement>("[data-canvas-unit]")]
          : [...plane.querySelectorAll<HTMLElement>(is("data-canvas-unit", place.unit_id))];
      for (const unit of units) {
        if (place.record_id !== undefined) {
          const row = is("row-id", place.record_id);
          const found = unit.querySelector<HTMLElement>(
            place.field_id === undefined ? row : `${row} ${is("col-id", place.field_id)}`,
          );
          if (found !== null) return found;
        } else if (place.unit_id !== undefined) return unit.querySelector("header");
      }
      return null;
    };
    /** Decided as the popover first places itself: beside the target when it is on screen. */
    let beside: boolean | null = null;
    return {
      get current(): HTMLElement | null {
        if (id === null) return null;
        const target = find();
        if (beside === null) {
          const viewport = root.current
            ?.querySelector<HTMLElement>("[data-canvas-plane] [role='region']")
            ?.getBoundingClientRect();
          const box = target?.getBoundingClientRect();
          beside =
            box !== undefined &&
            viewport !== undefined &&
            box.bottom > viewport.top &&
            box.top < viewport.bottom &&
            box.right > viewport.left &&
            box.left < viewport.right;
        }
        return (beside ? target : null) ?? centre.current;
      },
    };
  }, [id, anchor, root, centre]);
}

/**
 * Rules live on the plane: a rule the layout has no card for gets one at a
 * free slot, and a card whose rule is gone leaves the layout. Each is tried
 * once, so a refused layout save is not retried in a loop.
 */
function useRulesOnPlane(
  session: CanvasSession,
  onFailed: (outcome: Extract<CanvasOutcome, { ok: false }>) => void,
  /** Marks the cards it places as the canvas's own adds, which are not followed. */
  markOwn: (before: CanvasLayout, after: CanvasLayout) => CanvasLayout,
) {
  const tried = useRef(new Set<string>());
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const { layout, layoutPending, rules, layoutError, commitLayout } = session;
  useEffect(() => {
    // An unreadable layout is left alone: placing a card would replace it.
    // A live drag or a drop still saving is left alone too; this runs again
    // with the settled layout.
    if (layoutError !== null || layoutPending) return;
    const ruleIds = new Set(rules.map((rule) => rule.id));
    const shown = new Set(
      layout.units.filter((unit) => unit.kind === "rule").map((unit) => unit.config.rule_id),
    );
    const missing = rules.filter(
      (rule) => !shown.has(rule.id) && !tried.current.has(`place:${rule.id}`),
    );
    const orphans = layout.units.filter(
      (unit) =>
        unit.kind === "rule" &&
        !ruleIds.has(unit.config.rule_id as string) &&
        !tried.current.has(`drop:${unit.id}`),
    );
    if (missing.length === 0 && orphans.length === 0) return;
    for (const rule of missing) tried.current.add(`place:${rule.id}`);
    for (const unit of orphans) tried.current.add(`drop:${unit.id}`);
    const dropped = new Set(orphans.map((unit) => unit.id));
    void commitLayout((current) => {
      let next = { ...current, units: current.units.filter((unit) => !dropped.has(unit.id)) };
      const placed = new Set(
        next.units.filter((unit) => unit.kind === "rule").map((unit) => unit.config.rule_id),
      );
      for (const rule of missing)
        if (!placed.has(rule.id)) next = markOwn(next, addUnit(next, "rule", { rule_id: rule.id }));
      return next;
    }).then((outcome) => {
      if (!outcome.ok) failed.current(outcome);
    });
  }, [layout, layoutPending, rules, layoutError, commitLayout]);
}

function EmptyCanvas({
  layoutError,
  children,
}: {
  layoutError: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex max-w-[var(--size-modal-sm)] flex-col items-center gap-[var(--space-3)] rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-8)] py-[var(--space-6)] text-center shadow-[var(--shadow-raised)]">
      <h2 className="m-[var(--space-0)] text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
        Nothing on the canvas yet
      </h2>
      <p className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-secondary)]">
        {layoutError === null
          ? "Add a table to edit records, a chart to see totals, or a graph to follow links between records."
          : "The saved layout could not be read. Add to the canvas to start a new one."}
      </p>
      {children}
    </div>
  );
}

/**
 * A chart filling its unit below the header, leaving room for its padding and
 * the selected-bar line. The header grows when its filters wrap in a narrow
 * unit, so the room is measured, not assumed: the chart's legend stays in view.
 */
function ChartContent({
  client,
  session,
  store,
  unit,
}: {
  client: CanvasClient;
  session: CanvasSession;
  store: SelectionStore;
  unit: CanvasUnit;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const content = anchor.current?.closest<HTMLElement>("[data-unit-content]");
    if (content === null || content === undefined) return;
    const measure = () => setRoom(content.clientHeight > 0 ? content.clientHeight : null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Before it is measured: the frame's height less a one-row header.
  const height = Math.max(160, room === null ? unit.h - 128 : room - 80);
  return (
    <div className="contents" ref={anchor}>
      <ChartUnit
        client={client}
        config={unit.config}
        height={height}
        selection={store}
        session={session}
        unitId={unit.id}
      />
    </div>
  );
}

/** One unit's content, by kind. */
function UnitContent({
  client,
  session,
  store,
  unit,
  onOpenRecord,
  onOpenThread,
  onReveal,
}: {
  client: CanvasClient;
  session: CanvasSession;
  store: SelectionStore;
  unit: CanvasUnit;
  onOpenRecord: (record: Opened) => void;
  onOpenThread: (on: readonly CanvasThread[]) => void;
  onReveal: (unitId: string, reveal: GridReveal | null) => void;
}) {
  if (unit.kind === "chart")
    return <ChartContent client={client} session={session} store={store} unit={unit} />;
  if (unit.kind === "kpi")
    return (
      <KpiUnit
        client={client}
        config={unit.config}
        selection={store}
        session={session}
        unitId={unit.id}
      />
    );
  if (unit.kind === "graph")
    return (
      <GraphUnit
        client={client}
        config={unit.config}
        selection={store}
        session={session}
        unitId={unit.id}
      />
    );
  const modelId = unitModelId(unit);
  if (modelId === null)
    return (
      <p className="m-[var(--space-0)] p-[var(--space-4)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        This table does not name its records.
      </p>
    );
  return (
    <GridUnitView
      client={client}
      modelId={modelId}
      session={session}
      store={store}
      unitId={unit.id}
      onOpenRecord={onOpenRecord}
      onOpenThread={onOpenThread}
      onReveal={onReveal}
    />
  );
}

/** A grid unit with comment-mode anchoring on its cells and pins for their open threads. */
function GridUnitView({
  client,
  session,
  store,
  unitId,
  modelId,
  onOpenRecord,
  onOpenThread,
  onReveal,
}: {
  client: CanvasClient;
  session: CanvasSession;
  store: SelectionStore;
  unitId: string;
  modelId: string;
  onOpenRecord: (record: Opened) => void;
  onOpenThread: (on: readonly CanvasThread[]) => void;
  onReveal: (unitId: string, reveal: GridReveal | null) => void;
}) {
  const comment = useCommentMode();
  const labels = useMemo(() => createLabelIndex(client.definition), [client.definition]);
  // Open cell threads of this model, by cell; the pin function changes only with them.
  const cellThreads = session.threads.filter((thread) => {
    const anchor = threadAnchor(thread);
    return !thread.resolved && anchor.model_id === modelId && anchor.field_id !== undefined;
  });
  const pinsKey = JSON.stringify(cellThreads.map((thread) => [thread.id, thread.anchor]));
  const cellPin = useMemo(
    () => {
      const threads = cellThreads;
      return (recordId: string, fieldId: string) => {
        const on = threadsOn(threads, {
          model_id: modelId,
          record_id: recordId,
          field_id: fieldId,
        });
        return threadCellPin(on.length, labels.header(modelId, fieldId), () => onOpenThread(on));
      };
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, so the grid keeps its columns.
    [pinsKey, modelId, labels, onOpenThread],
  );
  const onCellClicked = useCallback(
    (cell: { recordId: string; fieldId: string }) => {
      comment.anchor({
        unit_id: unitId,
        model_id: modelId,
        record_id: cell.recordId,
        field_id: cell.fieldId,
      });
    },
    [comment, unitId, modelId],
  );
  const onGridReveal = useCallback(
    (reveal: GridReveal | null) => onReveal(unitId, reveal),
    [onReveal, unitId],
  );
  return (
    <GridUnit
      cellPin={cellPin}
      client={client}
      modelId={modelId}
      selection={store}
      session={session}
      unitId={unitId}
      onCellClicked={comment.on ? onCellClicked : undefined}
      onOpenRecord={(recordId) => onOpenRecord({ modelId, recordId })}
      onReveal={onGridReveal}
    />
  );
}
