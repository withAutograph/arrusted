/*
 * Core design-system icon barrel.
 *
 * Components inside this design system import icons FROM HERE only — never
 * directly from @heroicons/react. The barrel is the single point where the
 * icon-library binding lives, so another token implementation can re-export
 * the same names from a different library (lucide, phosphor, custom SVGs)
 * without touching any component code.
 *
 * Curate as needed: only export icons that have an actual consumer. The
 * frontend boundary scanner enforces the no-direct-import rule.
 */

export {
  ArrowUturnLeftIcon as Undo,
  ArrowPathIcon as Spinner,
  // Same glyph as Spinner, exported again under the name that is honest where
  // it does not spin: a "re-run" affordance at rest. Two names cost nothing and
  // keep both call sites readable.
  ArrowPathIcon as Refresh,
  ArrowRightIcon as ArrowRight,
  ArrowUpIcon as ArrowUp,
  ArrowsPointingInIcon as ArrowsPointingIn,
  // Pending items that want attention (the canvas's drafts-to-review button).
  BellIcon as Bell,
  BoltIcon as Bolt,
  CalendarDaysIcon as Calendar,
  // A comment or side thread pinned to something (comp canvas thread pins).
  ChatBubbleLeftIcon as Comment,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircle,
  ChevronDownIcon as ChevronDown,
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  ChevronUpIcon as ChevronUp,
  ClipboardDocumentListIcon as ClipboardDocumentList,
  CurrencyDollarIcon as CurrencyDollar,
  FingerPrintIcon as FingerPrint,
  InboxIcon as Inbox,
  ListBulletIcon as ListBullet,
  MagnifyingGlassIcon as Search,
  MinusIcon as Minus,
  NoSymbolIcon as NoSymbol,
  PlusIcon as Plus,
  SparklesIcon as Sparkles,
  StopIcon as Stop,
  TableCellsIcon as TableCells,
  TagIcon as Tag,
  TrashIcon as Trash,
  UserIcon as User,
  XMarkIcon as Close,
} from "@heroicons/react/24/outline";

// Solid variants: used where a filled glyph reads as a status token rather
// than an outline affordance (e.g. the agent avatar mark, a settled success
// check inside a confirmation banner).
export {
  SparklesIcon as SparklesSolid,
  CheckCircleIcon as CheckCircleSolid,
} from "@heroicons/react/24/solid";

export type IconComponent = typeof import("@heroicons/react/24/outline").ChevronDownIcon;
