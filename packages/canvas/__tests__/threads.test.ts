import { describe, expect, test } from "vite-plus/test";
import { parseThreads } from "../threads";

/** A thread as `kernel_work_session` `get` returns it, with the record gone. */
const kernelThread = {
  id: "t",
  anchor: {
    model_id: "m_person",
    record_id: "00000000-0000-4000-8000-000000000001",
    field_id: "f_score",
    gone: "record_gone",
  },
  resolved: false,
  messages: [
    {
      id: "reply-1",
      actor_id: "user-1",
      author_kind: "human",
      message: "Why?",
      created_at: "2026-10-01T09:00:00.000Z",
    },
  ],
  proposal: {
    id: "proposal-1",
    changes: [
      {
        model_id: "m_person",
        record_id: "00000000-0000-4000-8000-000000000001",
        field_id: "f_score",
        value: { type: "number", value: "2" },
        gone: "record_gone",
      },
    ],
    actor_id: "user-1",
    author_principal: "agent:assistant",
    author_kind: "agent",
    created_at: "2026-10-01T09:01:00.000Z",
  },
};

describe("threads", () => {
  test("parses the kernel's thread shape with messages and a proposal", () => {
    const [thread] = parseThreads({ t: kernelThread });
    expect(thread).toEqual(kernelThread);
  });

  test("rejects a thread that is not the kernel's shape", () => {
    expect(() => parseThreads({ t: { id: "t", anchor: {}, messages: [] } })).toThrow();
  });
});
