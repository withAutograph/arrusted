import type { BetterAuthPlugin, DBAdapter } from "better-auth";

/** Preserve empty-set read semantics without sending an unsupported SQL IN (). */
export function emptySetAdapter() {
  return {
    id: "empty-set-adapter" as const,
    init(context) {
      const findMany = context.adapter.findMany.bind(context.adapter);
      context.adapter.findMany = async <T>(
        input: Parameters<DBAdapter["findMany"]>[0],
      ): Promise<T[]> => {
        const predicate = input.where?.[0];
        // A single empty IN predicate is always false. Mixed predicates retain
        // their adapter-owned AND/OR semantics and are delegated unchanged.
        if (
          input.where?.length === 1 &&
          predicate?.operator === "in" &&
          Array.isArray(predicate.value) &&
          predicate.value.length === 0
        ) {
          return [];
        }
        return findMany<T>(input);
      };
    },
  } satisfies BetterAuthPlugin;
}
