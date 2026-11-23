export type RuleEvent<TType extends string = string, TPayload = Record<string, unknown>> = {
  type: TType;
  payload: TPayload;
};

export type RuleFailure<TEvent extends RuleEvent = RuleEvent> = {
  ruleId: string;
  event: TEvent;
  error: unknown;
};

export type RuleRunInput<TEvent extends RuleEvent, TContext> = {
  event: TEvent;
  context: TContext;
  emit: (event: TEvent) => void;
};

export type Rule<TEvent extends RuleEvent = RuleEvent, TContext = unknown> = {
  id: string;
  eventTypes: readonly TEvent["type"][];
  when?: (input: { event: TEvent; context: TContext }) => boolean | Promise<boolean>;
  run: (input: RuleRunInput<TEvent, TContext>) => void | Promise<void>;
};

export type RunRulesOptions<TEvent extends RuleEvent, TContext> = {
  event: TEvent;
  context: TContext;
  rules: readonly Rule<TEvent, TContext>[];
  failureMode?: "best_effort" | "throw";
  maxDepth?: number;
  maxEmittedEvents?: number;
};

export type RunRulesResult<TEvent extends RuleEvent = RuleEvent> = {
  ran: string[];
  skipped: string[];
  failures: RuleFailure<TEvent>[];
  emitted: TEvent[];
};

type QueuedEvent<TEvent extends RuleEvent> = {
  event: TEvent;
  depth: number;
};

export async function runRules<TEvent extends RuleEvent, TContext>(
  options: RunRulesOptions<TEvent, TContext>,
): Promise<RunRulesResult<TEvent>> {
  const failureMode = options.failureMode ?? "best_effort";
  const maxDepth = options.maxDepth ?? 8;
  const maxEmittedEvents = options.maxEmittedEvents ?? 100;
  const queue: Array<QueuedEvent<TEvent>> = [{ event: options.event, depth: 0 }];
  const eventTypesByRule = new Map(
    options.rules.map((rule) => [rule, new Set<TEvent["type"]>(rule.eventTypes)] as const),
  );
  const result: RunRulesResult<TEvent> = {
    ran: [],
    skipped: [],
    failures: [],
    emitted: [],
  };

  while (queue.length > 0) {
    const { event, depth } = queue.shift() as QueuedEvent<TEvent>;
    const runRule = async (rule: Rule<TEvent, TContext>) => {
      if (!eventTypesByRule.get(rule)?.has(event.type)) {
        result.skipped.push(rule.id);
        return;
      }

      try {
        const shouldRun = rule.when ? await rule.when({ event, context: options.context }) : true;
        if (!shouldRun) {
          result.skipped.push(rule.id);
          return;
        }

        const emittedByRule: TEvent[] = [];
        await rule.run({
          event,
          context: options.context,
          emit: (emittedEvent) => {
            if (depth + 1 > maxDepth) {
              throw new Error(`Rule event depth exceeded ${maxDepth}.`);
            }
            if (result.emitted.length + emittedByRule.length >= maxEmittedEvents) {
              throw new Error(`Rule emission limit exceeded ${maxEmittedEvents}.`);
            }
            emittedByRule.push(emittedEvent);
          },
        });
        for (const emittedEvent of emittedByRule) {
          result.emitted.push(emittedEvent);
          queue.push({ event: emittedEvent, depth: depth + 1 });
        }
        result.ran.push(rule.id);
      } catch (error) {
        result.failures.push({ ruleId: rule.id, event, error });
        if (failureMode === "throw") {
          throw error;
        }
      }
    };
    // Preserve ordered rule execution and reject-on-first-failure semantics
    // without `await` inside the loop.
    let sequence = Promise.resolve();
    for (const rule of options.rules) {
      sequence = sequence.then(() => runRule(rule));
    }
    await sequence;
  }

  return result;
}
