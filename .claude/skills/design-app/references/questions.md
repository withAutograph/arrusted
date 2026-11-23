# Interview questions

Classify every question before asking it.

| Class | Meaning | Behavior |
| --- | --- | --- |
| Blocker | The job to be done is missing, or two readings would give clearly different products | Ask one concise question and wait. |
| Shapes data, permissions, workflow or irreversible behavior | The answer changes what is stored, who may act, what order things happen, or something that cannot be taken back | Ask before building if no safe default exists; otherwise state the default and ask during iteration. |
| Refines realism | Helps but does not change the next prototype | Note it; ask during feedback, at most three at once. |
| Implementation detail | Claude can decide from the repository | Never ask. Decide, and explain only if it matters to them. |

Prefer one question. Always say the default you will use if they have no
preference.

## Do not ask which layout they want

Do not ask the builder to choose among dashboard, table, form, queue, board or
detail view when the workflow implies a reasonable default. Pick one, show it,
and let them react.

## Shaping questions (use when the answer is not inferable)

User and first use
- "Who opens this most often, and what should they do first?"
- "Who relies on the result even if they never open it?"

Workflow and decisions
- "What decision should this help someone make?"
- "Is this a separate workflow, or the same records seen a different way?"
- "Which mistake would be most costly or embarrassing?"

Data
- "What real-world things does this keep track of?" (companies, people,
  deals, invoices...)
- "What tells two of them apart?" (email, invoice number...)
- "Which links matter?" (each deal belongs to one company...)
- "Which details are needed to act, versus nice to see?"
- "Where does this information come from today: a spreadsheet, typing it in,
  or another system?"

## During iteration, anchor to what they see

- "Deals are grouped by stage. Should owner also be a grouping?"
- "Opening a deal shows its activity here. Would you rather filter the list?"
- "This empty state offers a CSV import. Is typing them in more realistic?"

## Must be settled before "build this"

Writes and review
- "Does this action change saved records, or only what's on screen?"
- "Does anyone need to review a change before it counts?"

Access and sensitivity
- "Who should see this? Is there anything here (pay, personal or financial
  details) that only some people should see?"
- By default everyone signed in sees every section; ask only if the content
  suggests otherwise.

Irreversible behavior
- "Should this ever send an email, notify someone, or pay anything? Who must
  confirm first?"

Claude over MCP
- "Should Claude only read this, suggest changes as drafts, or make changes?"

Scope
- "Which parts of what you clicked through are needed for the first version,
  and which were just illustrative?"

## Never ask the builder

Table or column design, field types, migrations, CUE, row-level security,
package placement, component names, test runners, or deployment commands.
