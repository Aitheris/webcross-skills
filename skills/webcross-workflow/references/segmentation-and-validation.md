# Segmentation Contracts, Closed-Loop Validation, and Delivery

Use this reference when splitting a Workflow at an Agent or human decision
boundary, running L1–L3 validation, and persisting segments into Workshop.

## 1. Default mode: Agent-parameterized multi-segment handoff

By default, every segment is authored for **Agent-parameterized orchestration**
(`Workflow.execute({ workshopId, input, binding })`):

- Validate required `input` fields at the start of `export default`. Do not call
  `DOM.getAXTree` to guess missing parameters.
- Return compact plain-JSON `output` (`<= 4 MiB`). When exporting large tables
  or reports, save UTF-8 text via `File.write` and expose the descriptor under
  `output.file` (`savedPath`, `relativePath`, `bytes`).
- Save segments requiring non-empty `input` with **`enabled: false`** in
  `Workflow.upsert` so browser toolbar users cannot accidentally invoke them
  with `{}`.

### Segment 01 template — Pre-boundary preparation & clean candidate extraction

```ts
export interface Segment01Input {
  readonly searchUrl: string;
  readonly keyword: string;
  readonly excludedTerms?: readonly string[];
}

export interface CleanedVendorOption {
  readonly value: string;
  readonly label: string;
}

export interface Segment01Output {
  readonly pageId: string;
  readonly landedUrl: string;
  readonly keyword: string;
  readonly vendorCandidates: CleanedVendorOption[];
  readonly file?: {
    readonly savedPath: string;
    readonly relativePath: string;
    readonly bytes: number;
  };
}

function parseSegment01Input(raw: unknown): Segment01Input {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Segment01Input must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.searchUrl !== "string" || record.searchUrl.length === 0) {
    throw new Error("Segment01Input.searchUrl is required.");
  }
  if (
    typeof record.keyword !== "string" ||
    record.keyword.trim().length === 0
  ) {
    throw new Error("Segment01Input.keyword is required.");
  }
  const excludedTerms = Array.isArray(record.excludedTerms)
    ? record.excludedTerms.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  return {
    searchUrl: record.searchUrl,
    keyword: record.keyword.trim(),
    excludedTerms,
  };
}

export default async function runSegment01(
  api: WorkflowApi,
  rawInput: unknown,
): Promise<Segment01Output> {
  const input = parseSegment01Input(rawInput);
  const pageId = api.context.pageId;
  if (!pageId) {
    throw new Error("Bind a target pageId when executing Segment 01.");
  }

  const nav = await api.waitFor(
    {
      events: ["Page.loaded", "Page.loadFailed"],
      pageId,
      timeoutMs: 25_000,
    },
    () =>
      api.actions.Page.navigate({
        pageId,
        url: input.searchUrl,
        purpose: "Open supplier filter view",
      }),
  );
  if (nav.event.event === "Page.loadFailed") {
    throw new Error(nav.event.payload.failure.message);
  }

  // Tier 0: known search input and filter button selectors need no re-observation.
  const sinceMs = Date.now();
  await api.actions.Input.type({
    pageId,
    selector: "input[name='keyword']",
    text: input.keyword,
    clear: true,
    purpose: "Enter supplier keyword",
  });
  await api.actions.Input.click({
    pageId,
    selector: "button[data-action='apply-filter']",
    purpose: "Trigger filtered supplier query",
  });

  // Tier 1 bounded convergence: wait for filter API + native vendor select refresh.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const net = await api.actions.Network.readApi({
      pageId,
      sinceMs,
      urlPattern: "/api/suppliers",
      limit: 10,
      purpose: "Check supplier filter XHR completion",
    });
    if (net.apis.length > 0 && net.pendingCount === 0) break;
    await api.sleep(250);
  }

  const selectInfo = await api.actions.DOM.inspectSelect({
    pageId,
    selector: "select[name='vendorId']",
    purpose: "Read candidate suppliers for Agent or human review",
  });
  if (selectInfo.type !== "select") {
    throw new Error("Expected native <select> for select[name='vendorId'].");
  }

  const forbidden = (input.excludedTerms ?? ["deprecated", "suspended"]).map(
    (item) => item.toLowerCase(),
  );
  const vendorCandidates: CleanedVendorOption[] = selectInfo.options
    .filter((opt) => !opt.disabled && opt.value.trim().length > 0)
    .filter((opt) => {
      const lower = opt.label.trim().toLowerCase();
      return (
        lower !== "select..." &&
        lower !== "请选择" &&
        !lower.startsWith("+ ") &&
        !forbidden.some((term) => lower.includes(term))
      );
    })
    .map((opt) => ({ value: opt.value, label: opt.label }));

  // Clean exit before semantic/human vendor choice so no Worker sits idle.
  return {
    pageId,
    landedUrl: nav.event.payload.url,
    keyword: input.keyword,
    vendorCandidates,
  };
}
```

### Segment 02 template — Post-boundary deterministic execution

```ts
export interface Segment02Input {
  readonly selectedVendorValue: string;
  readonly note: string;
}

export interface Segment02Output {
  readonly confirmedVendorValue: string;
  readonly confirmedVendorLabel: string;
  readonly confirmationBanner: string;
}

function parseSegment02Input(raw: unknown): Segment02Input {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Segment02Input must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.selectedVendorValue !== "string" ||
    record.selectedVendorValue.trim().length === 0
  ) {
    throw new Error("Segment02Input.selectedVendorValue is required.");
  }
  if (typeof record.note !== "string") {
    throw new Error("Segment02Input.note must be a string.");
  }
  return {
    selectedVendorValue: record.selectedVendorValue.trim(),
    note: record.note,
  };
}

export default async function runSegment02(
  api: WorkflowApi,
  rawInput: unknown,
): Promise<Segment02Output> {
  const input = parseSegment02Input(rawInput);
  const pageId = api.context.pageId;
  if (!pageId) {
    throw new Error("Bind the active pageId from Segment 01.");
  }

  // Tier 1 precondition probe: confirm form control is live without DOM.getAXTree.
  const inspected = await api.actions.DOM.inspectSelect({
    pageId,
    selector: "select[name='vendorId']",
    purpose: "Verify approved vendor remains enabled before commit",
  });
  if (inspected.type !== "select") {
    throw new Error("Expected native <select> for select[name='vendorId'].");
  }
  const target = inspected.options.find(
    (opt) => !opt.disabled && opt.value === input.selectedVendorValue,
  );
  if (!target) {
    throw new Error(
      `Approved vendor "${input.selectedVendorValue}" is unavailable or disabled.`,
    );
  }

  const selected = await api.actions.Input.select({
    pageId,
    id: inspected.controlId,
    selector: "select[name='vendorId']",
    selections: [{ value: target.value }],
    purpose: "Select approved supplier",
  });
  if (selected.type !== "select" || selected.selected.length === 0) {
    throw new Error("Supplier selection was not confirmed.");
  }

  // Tier 0: type note and click submit directly.
  await api.actions.Input.type({
    pageId,
    selector: "textarea[name='approvalNote']",
    text: input.note,
    clear: true,
    purpose: "Fill approval note",
  });
  await api.actions.Input.click({
    pageId,
    selector: "button[type='submit']",
    purpose: "Submit supplier assignment",
  });

  // Tier 1 post-condition poll on known status banner.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const banner = await api.actions.DOM.getDetails({
      pageId,
      query: {
        view: "text",
        targets: [{ selector: "[data-testid='submission-banner']" }],
        textMode: "rendered",
      },
      purpose: "Confirm submission banner text",
    });
    const first = banner.details[0];
    if (
      first?.ok &&
      "value" in first &&
      typeof first.value === "string" &&
      first.value.trim().length > 0
    ) {
      return {
        confirmedVendorValue: selected.selected[0].value,
        confirmedVendorLabel: selected.selected[0].label,
        confirmationBanner: first.value.trim(),
      };
    }
    await api.sleep(250);
  }
  throw new Error("Submission banner did not appear before timeout.");
}
```

## 2. Opt-in Dual-Mode entry guard (explicit user request only)

Only use this pattern when the user explicitly asks to trigger the Workflow from
the browser Workshop toolbar menu (where `input` is always `{}`). Keep the
precondition check strictly lightweight (`api.context.hostname` + one Tier 1
`DOM.getDetails` probe — never `DOM.getAXTree`).

```ts
export interface DualModeExportInput {
  readonly fileName?: string;
}

export default async function runDualModeExport(
  api: WorkflowApi,
  rawInput: unknown = {},
): Promise<{
  file: { savedPath: string; relativePath: string; bytes: number };
}> {
  const record =
    typeof rawInput === "object" &&
    rawInput !== null &&
    !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const fileName =
    typeof record.fileName === "string" && record.fileName.trim().length > 0
      ? record.fileName.trim()
      : "summary-export.json";

  if (api.context.hostname !== "portal.example.com") {
    throw new Error(
      `Open https://portal.example.com/reports before running this Workshop item (got ${api.context.hostname ?? "unbound"}).`,
    );
  }

  const probe = await api.actions.DOM.getDetails({
    query: {
      view: "text",
      targets: [{ selector: "[data-testid='report-summary']" }],
      textMode: "rendered",
    },
    purpose: "Read report summary for Workshop export",
  });
  const detail = probe.details[0];
  if (!detail?.ok || !("value" in detail) || typeof detail.value !== "string") {
    throw new Error(
      "Report summary element [data-testid='report-summary'] is not ready.",
    );
  }

  const file = await api.actions.File.write({
    fileName,
    overwrite: true,
    content: JSON.stringify({ summary: detail.value.trim() }, null, 2),
    purpose: "Save report summary artifact",
  });
  return {
    file: {
      savedPath: file.savedPath,
      relativePath: file.relativePath,
      bytes: file.bytes,
    },
  };
}
```

## 3. Three-layer validation checklist (Phase 4)

### L1 — Static, bundle, and performance/precision audit

When local `webcross` CLI and `tsc` are available, validate offline before live
execution:

```sh
webcross workflow types --out webcross.d.ts
tsc --noEmit
webcross workflow pack . --out segment.workshop.json
```

Verify every item below before running `Workflow.execute`:

- [ ] **Schema & compilation**: `schemaVersion: 1`, `1–64` source files, each
      `<= 256 KiB`, total `<= 2 MiB`; `entry` has `export default`; relative TypeScript
      imports end in `.js`; no dynamic `import()`; no Web/Node globals (`URL`,
      `fetch`, `setTimeout`, `process`).
- [ ] **Selector durability**: Zero hardcoded transient observation `nodeId`s
      from earlier sessions; selectors were verified unique via `DOM.getDetails` or
      `DOM.inspectSelect`.
- [ ] **`DOM.getAXTree` budget**: Zero `DOM.getAXTree` calls inside loops or
      polling blocks; any remaining `DOM.getAXTree` satisfies both conditions of the
      dual-condition gate and releases `readText` strings immediately.
- [ ] **Async accuracy**: SPA route transitions wait on `Page.navigate` + Tier 1
      anchor (not `Page.loaded`); local XHR/cascading updates use baseline `sinceMs`
  - bounded backoff (no blind multi-second `sleep`); new tabs check
    `Page.getState` before waiting on `Page.loaded`.
- [ ] **Option precision**: Every selectable component strips `disabled` /
      `aria-disabled`, applies blacklist + whitelist, and enforces cardinality + a
      user-confirmed `DeterministicTieBreaker` (never silent `[0]`).
- [ ] **Audit & teardown**: Every proxied Action has a clear `purpose`; every
      platform call is `await`ed before returning; `Input.move({ auto: true })` is
      paired with `Input.move({ auto: false })` inside `finally`; concurrency batches
      stay `<= 8`.

### L2 — Live sandbox replay

Run `Workflow.execute({ workflow, input, binding: { fleetId, pageId } })` from
the segment's authentic starting state (after obtaining **Gate 2** approval if
the segment performs irreversible writes).

### L3 — Execution trace & post-condition audit

1. **Check `result.status` first**: Confirm `result.status === "succeeded"`. A
   resolved `Workflow.execute` call can still report `"failed"` or `"cancelled"`.
2. **Audit `result.results`**: Count total platform calls and confirm actual
   `DOM.getAXTree` invocations match the approved budget (ideally `0` for
   known-structure segments).
3. **Verify post-condition**: Run one lightweight `DOM.getDetails` or
   `Page.getState` check to confirm the browser rests in the expected end state.
4. **Bounded repair**: On failure, inspect `result.error` (`code`, `message`,
   `action`, `actionCode`, `source.file`, `source.line`) and perform at most **2
   evidence-driven fixes** before reporting the blocker to the user.

## 4. Workshop persistence & Segmented Orchestration Playbook (Gate 4)

Before calling `Workflow.upsert`:

- Reuse `workshopId` when updating an existing script discovered via
  `Workflow.list`.
- Name multi-segment pipelines sequentially: `[<Flow Name>] 01 - <Verb Noun>`,
  `[<Flow Name>] 02 - <Verb Noun>`.
- Set **`enabled: false`** on every segment that requires non-empty `input`
  (unless Dual-Mode was explicitly requested and validated with `input: {}`).
- Assign `folderId` only from existing `folders` returned by `Workflow.list`
  (or `null` for root).

After `Workflow.upsert` succeeds, present this concise playbook to the user:

```markdown
### Segmented Orchestration Playbook — <Flow Name>

1. **Segment 01**: `<name>` (`workshopId`: `<id>`, `enabled`: `false`)
   - **Call**: `Workflow.execute({ workshopId: "<id>", binding: { fleetId, pageId }, input: <Segment01Input> })`
   - **Returns**: `<Segment01Output summary>`
2. **Boundary Handoff (<Agent Reasoning | Human Action>)**:
   - <Exact decision or manual step performed between Segment 01 output and Segment 02 input>
3. **Segment 02**: `<name>` (`workshopId`: `<id>`, `enabled`: `false`)
   - **Call**: `Workflow.execute({ workshopId: "<id>", binding: { fleetId, pageId }, input: <Segment02Input> })`
   - **Returns**: `<Segment02Output summary>`
```
