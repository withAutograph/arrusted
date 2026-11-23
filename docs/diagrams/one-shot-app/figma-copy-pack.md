# One-Shot App Figma-Safe Mermaid Copy Pack

These diagrams use a conservative Mermaid subset for reliable Figma and FigJam
import. Actor and readiness are written into each node so meaning survives when
an importer discards colors or shapes. The editable canonical diagrams live
beside this file as `.mmd` sources.

## Reading the boxes

```text
ACTOR
USER = intent, evidence, feedback, confirmation, or approval
AI = research, inference, design, specification, implementation, or repair
SYSTEM = repository tooling, runtime behavior, validation, or stored artifacts

STATUS
BUILT = exists with evidence today
PARTIAL = exists in pieces or requires manual work
MISSING = must be created or adapted
OUTCOME = target result
```

## 1. Journey overview

```mermaid
graph TD
  U0["PARTIAL - USER - Prepare the development machine"]
  S0["BUILT MANUAL - SYSTEM - Install dependencies and create local databases"]
  U1["BUILT - USER - State the job to be done and desired interfaces"]
  G1["PARTIAL - GATE - JTBD plus interfaces make the request prototype-ready"]
  A1["PARTIAL - AI - Run the Arrusted-adapted prototype skill"]
  S1["MISSING - SYSTEM - Generate self-contained clickable HTML"]
  U2["BUILT - USER - Try the prototype and give feedback"]
  A2["PARTIAL - AI - Iterate HTML and discover the app contract"]
  S2["MISSING - SYSTEM - Convert HTML plus decisions into a structured AppSpec"]
  G2["MISSING - GATE - Confirm integrations, data objects, behavior, and authority"]
  U3["MISSING - USER - Accept the build-ready prototype and AppSpec"]
  A3["PARTIAL - AI - Plan and build the real Arrusted app"]
  U4["BUILT - USER - Test the production-shaped preview"]
  S3["PARTIAL - SYSTEM - Validate implementation against the accepted AppSpec"]
  R["OUTCOME - Useful local first version"]

  U0 --> S0
  S0 --> U1
  U1 --> G1
  G1 --> A1
  A1 --> S1
  S1 --> U2
  U2 --> A2
  A2 --> S1
  A2 --> S2
  S2 --> G2
  G2 --> U2
  G2 --> U3
  U3 --> A3
  A3 --> U4
  U4 --> S3
  S3 --> R
```

## 2. Prototype and specification loop

```mermaid
graph TD
  S1["PARTIAL - SYSTEM - Load the adapted prototype skill"]
  U1["BUILT - USER - State the job to be done"]
  U2["BUILT - USER - Name desired interfaces"]
  A1["MISSING - AI - Label facts, evidence, assumptions, confirmations, and questions"]
  G1["PARTIAL - GATE - Are JTBD and interfaces present"]
  A2["PARTIAL - AI - Inspect relevant Arrusted capabilities and domain context"]
  A3["PARTIAL - AI - Select provisional workflows and realistic sample data"]
  S2["MISSING - SYSTEM - Generate self-contained clickable HTML"]
  U3["BUILT - USER - Use the prototype and give product-language feedback"]
  A4["PARTIAL - AI - Revise HTML and record visible behavior decisions"]
  A5["PARTIAL - AI - Infer integrations, imports, data objects, and relationships"]
  U4["BUILT - USER - Confirm or correct inferred production meaning"]
  A6["PARTIAL - AI - Derive routes, controls, actions, time, writes, roles, and agent jobs"]
  S3["MISSING - SYSTEM - Synchronize HTML and structured AppSpec"]
  G2["MISSING - GATE - Are all blocking production decisions confirmed"]
  U5["MISSING - USER - Accept the build-ready prototype and AppSpec"]
  S4["MISSING - SYSTEM - Pass the accepted AppSpec to planning unchanged"]

  S1 --> U1
  U1 --> U2
  U2 --> A1
  A1 --> G1
  G1 --> U1
  G1 --> A2
  A2 --> A3
  A3 --> S2
  S2 --> U3
  U3 --> A4
  A4 --> S2
  A4 --> A5
  A5 --> U4
  U4 --> A6
  A6 --> S3
  S3 --> G2
  G2 --> S2
  G2 --> U4
  G2 --> U5
  U5 --> S4
```

## 3. Build-ready AppSpec gate

```mermaid
graph TD
  P1["REQUIRED - Approved HTML experience and interface inventory"]
  P2["REQUIRED - Confirmed integrations, imports, and source systems"]
  P3["REQUIRED - Confirmed data objects, fields, and relationships"]
  P4["REQUIRED - Controls, filters, grouping, as-of, comparisons, and actions"]
  P5["REQUIRED - Reads, writes, draft or review behavior, and authority boundaries"]
  P6["REQUIRED - Roles, permissions, agent responsibilities, and non-goals"]
  P7["REQUIRED - Empty, loading, failure, and first-use behavior"]
  P8["REQUIRED - Acceptance walkthrough and labeled unresolved decisions"]
  G["GATE - Build-ready"]
  R["OUTCOME - Accepted structured AppSpec"]

  P1 --> G
  P2 --> G
  P3 --> G
  P4 --> G
  P5 --> G
  P6 --> G
  P7 --> G
  P8 --> G
  G --> R
```

## 4. Plan and production build

```mermaid
graph TD
  S0["MISSING - SYSTEM - Receive accepted HTML plus structured AppSpec"]
  G0["MISSING - GATE - Verify build-ready acceptance"]
  A1["PARTIAL - AI - Create implementation plan from AppSpec"]
  U1["BUILT - USER - Review and approve the plan"]
  A2["PARTIAL - AI - Verify capabilities and map ownership"]
  S1["PARTIAL - SYSTEM - Run implementation preflight"]
  S2["PARTIAL - SYSTEM - Scaffold workspace"]
  S3["PARTIAL - SYSTEM - Define and validate schema"]
  S4["PARTIAL - SYSTEM - Build integrations and import adapters"]
  S5["PARTIAL - SYSTEM - Generate typed client and start API"]
  A3["PARTIAL - AI - Compose production UI and app-owned policy"]
  S6["PARTIAL - SYSTEM - Start local preview"]
  S7["PARTIAL - SYSTEM - Compare app with accepted HTML and AppSpec"]

  S0 --> G0
  G0 --> S0
  G0 --> A1
  A1 --> U1
  U1 --> A1
  U1 --> A2
  A2 --> S1
  S1 --> S2
  S2 --> S3
  S3 --> S4
  S4 --> S5
  S5 --> A3
  A3 --> S6
  S6 --> S7
```

## 5. Production preview, repair, and proof

```mermaid
graph TD
  U1["BUILT - USER - Open production-shaped preview"]
  U2["BUILT - USER - Perform the accepted AppSpec walkthrough"]
  S1["BUILT - SYSTEM - Execute governed reads and writes"]
  S2["PARTIAL - SYSTEM - Run automated checks and AppSpec comparison"]
  G1["PARTIAL - GATE - Do checks and walkthrough pass"]
  A1["PARTIAL - AI - Explain failure and make the smallest safe repair"]
  U3["BUILT - USER - Request correction in product language"]
  S3["MISSING - SYSTEM - Capture evidence, repairs, and limitations"]
  U4["MISSING - USER - Accept measured result"]
  R["OUTCOME - Useful local first version conforming to AppSpec"]

  U1 --> U2
  U2 --> S1
  S1 --> S2
  S2 --> G1
  G1 --> A1
  A1 --> U3
  U3 --> S2
  G1 --> S3
  S3 --> U4
  U4 --> R
```

## Prototype skill adaptation status

The repository-owned Arrusted skill now adapts the AG2 domain-first reasoning
spine as follows:

1. Move HTML generation immediately after the minimum JTBD plus interfaces gate.
2. Replace the mandatory pre-prototype full interview with labeled assumptions
   and a rapid visual feedback loop.
3. Inspect Arrusted's current docs, component catalog, Storybook, examples, and
   ownership rules instead of AG2 modes, manifests, and multi-verse concepts.
4. Read design tokens from the repository instead of copying literal colors and
   radii into the skill.
5. Generate self-contained HTML for discovery, but do not treat it as production
   code or persisted-data authority.
6. Maintain a structured AppSpec and decision ledger beside the HTML.
7. Require explicit confirmation of integrations and data objects before the
   build-ready gate.
8. Translate the accepted AppSpec into generated clients, app-owned adapters,
   production components, governed writes, and automated proof.
9. Compare the production result with both the accepted HTML experience and its
   structured AppSpec.

The instruction package, question guide, AppSpec contract, repository router,
and acceptance gate are built. Deterministic artifact generation,
synchronization, and production comparison remain automation backlog.
