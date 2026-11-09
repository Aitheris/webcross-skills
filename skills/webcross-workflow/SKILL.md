---
name: webcross-workflow
description: >-
  Interactively demonstrate, author, validate, split, and persist deterministic
  WebCross Workflows through live browser verification and explicit user gates.
  Read this skill whenever creating, recording, refining, debugging, splitting,
  or saving reusable WebCross Workflows (`Workflow.execute`, `Workflow.upsert`,
  or `webcross workflow`).
compatibility: Requires a running WebCross instance with Workflow entitlement and an available webcross CLI, MCP, or WebSocket connection.
---

# WebCross Workflow Authoring

Use this skill to author production-grade WebCross Workflows incrementally:
**demonstrate micro-steps in the live browser -> detect judgment or multi-choice
boundaries -> synthesize strict TypeScript -> validate in the sandbox -> obtain
explicit user confirmation before persisting**.

For general connection setup, Fleet hygiene, and one-off interactive browsing,
follow `webcross-browser` first.

## Scope, prerequisites, and default target mode

- **Entitlement**: Workflow authoring and Workshop persistence (`Workflow.list`,
  `Workflow.execute`, `Workflow.upsert`, `Workflow.remove`) require an active
  Workflow entitlement. If `Workflow.execute` or `Workflow.list` is unavailable
  in the current capability set, report the entitlement blocker immediately.
- **Sandbox reality**: Workflow scripts execute inside an isolated QuickJS-NG
  WASI worker (`64 MiB` heap, `512 KiB` native stack, `8` concurrent IO slots,
  `64` queued IO calls, `30 min` default deadline that **continues ticking while
  paused**). Scripts have no LLM reasoning, no host/Node modules, no nested
  `Workflow.execute`, and no browser Web APIs (`URL`, `fetch`, `setTimeout`,
  `document`, `window` do not exist; use `api.sleep()`, `api.context`,
  `Date.now()`, and pure ECMAScript helpers).
- **Default delivery mode — Agent-Parameterized Pipeline**:
  - Every Workflow or segment defaults to typed `Input` and `Output` JSON
    contracts invoked by an Agent via
    `Workflow.execute({ workshopId, input, binding })`.
  - Validate required `input` fields at the top of `export default` instead of
    probing the page to guess missing parameters.
  - When persisting a segment that requires non-empty `input` via
    `Workflow.upsert`, set **`enabled: false` by default** so the browser
    Workshop toolbar menu (which always passes `input: {}`) does not expose a
    button that fails on empty input. Agent execution via `workshopId` remains
    unaffected by `enabled` and `availability`.
- **Opt-in Dual-Mode compatibility (explicit user request only)**:
  - Only add `input = {}` fallback defaults, lightweight page precondition
    guards, `availability` host rules, and `enabled: true` when the user
    explicitly asks to run the Workflow manually from the browser Workshop menu.

## Six-phase interactive authoring loop

1. **Phase 0 — Preflight, deduplication, and Gate 0 alignment**
   - Confirm active `fleetId` and `pageId` (`Fleet.list`, `Page.list`,
     `Page.getState`).
   - Call `Workflow.list` to inspect existing Workshop scripts and `folders` so
     you update an existing script instead of duplicating it. (Workshop folders
     are managed in WebCross User UI, not created by Agent Actions.)
   - Present **Gate 0** to align on start/end states, `input`/`output` schema,
     default Agent-parameterized mode vs. Dual-Mode, and known option
     whitelists/blacklists.
2. **Phase 1 — Live micro-step demonstration**
   - Advance step-by-step on the live page while strictly obeying the
     **Three-Tier Observation Budget** below.
   - Verify stable selectors via `DOM.getDetails({ query })` rather than relying
     on transient `nodeId`s across navigations or re-renders.
   - Measure the real **Async Convergence** signal of each transition and
     inspect live options on every selectable control (`DOM.inspectSelect` or
     bounded `DOM.getDetails`).
   - Stop at **Gate 2** before executing any irreversible write, submission,
     deletion, payment, or external notification.
3. **Phase 2 — Multi-candidate and segmentation boundary check (Gate 1)**
   - **Multi-candidate choice**: If a selectable control still has `> 1` valid
     candidates after state + blacklist + whitelist filtering, **never silently
     pick the first item**. Stop at **Gate 1** and ask the user either to
     authorize a **deterministic tie-breaking sort rule** or to split the
     Workflow at this decision point.
   - **Judgment or human boundary**: If the next step requires open-ended Agent
     reasoning, unstructured text/image interpretation, or human intervention
     (QR/SMS/MFA/CAPTCHA login, subjective selection, financial/publish review),
     **automatically split** the Workflow into pre-boundary and post-boundary
     segments and confirm the `output` -> `input` handoff at **Gate 1**.
4. **Phase 3 — Incremental TypeScript synthesis**
   - Synthesize clean `es2022` ESM TypeScript (`schemaVersion: 1`, `entry` with
     `export default`, relative `.js` imports for helper `.ts` files, `purpose`
     on every proxied Action, `await` on every platform operation, and
     `Input.move({ auto: false })` inside `finally`).
5. **Phase 4 — Three-layer closed-loop validation (L1–L3)**
   - **L1 Static & budget audit**: Run `webcross workflow types` +
     `tsc --noEmit` + `webcross workflow pack` when local CLI/TypeScript is
     available, and verify every rule in the static audit checklist in
     `references/segmentation-and-validation.md`.
   - **L2 Sandbox replay**: Reset or navigate to the segment's expected entry
     state and run `Workflow.execute({ workflow, input, binding })`.
   - **L3 Trace & post-condition audit**: Check `result.status === "succeeded"`
     first (the `Workflow.execute` call itself resolves even when
     `result.status` is `"failed"` or `"cancelled"`), verify `result.results`
     call count and `DOM.getAXTree` count match the minimum budget, and run one
     Tier 1 probe to confirm the post-condition. Perform at most **2
     evidence-driven repair attempts** from `result.error` (`source.file`,
     `source.line`, `action`, `actionCode`) before asking the user.
6. **Phase 5 — Segment sign-off (Gate 3), handoff, and delivery (Gate 4)**
   - Present verified execution metrics at **Gate 3**.
   - If later segments remain, perform the intermediate Agent reasoning or wait
     for the user's manual step, establish the next segment's starting state and
     sample `input`, and return to Phase 1.
   - Once all segments pass Gate 3, confirm Workshop metadata at **Gate 4**,
     call `Workflow.upsert`, and output the **Segmented Orchestration Playbook**.

## Performance and three-tier observation budget

Apply this ladder both **during live demonstration** and **inside generated
Workflow code**:

### Tier 0 — Zero re-observation (default)

Do **not** call any observation Action after deterministic local operations
(`Input.type`, `Input.press`, checkbox toggles, or `Input.select`, whose return
value already confirms `selected` options) when the next target's selector is
already known and structurally unaffected.

### Tier 1 — Lightweight bounded probes (standard verification & polling)

Prefer zero-artifact live probes whenever checking known targets, containers,
options, lifecycle, or XHR progress:

- `DOM.getDetails` with `query` (`view: "state" | "text" | "attributes" | "dom"`,
  batching up to `64` targets in one call and bounding `maxDepth` on `"dom"`).
- `DOM.inspectSelect` for native `<select>`, date/time, and color controls.
- `Page.getState` for `status`, `url`, `isBlocked`, `hitl`, and native `dialogs`.
- `Network.readApi` (`sinceMs`, `urlPattern`, `pendingCount`) and
  `Network.readBody` for API-backed updates.

### Tier 2 — Full structural observation (`DOM.getAXTree` dual-condition gate)

`DOM.getAXTree` walks all frames and Shadow DOM trees, writes a disk artifact,
and `readText` can pull up to `4 MiB` into the `64 MiB` QuickJS heap. Call
`DOM.getAXTree` **only when BOTH conditions hold simultaneously**:

1. **Clear structural side effect**: Initial entry onto an unknown page,
   cross-page navigation landing, SPA route view replacement, an out-of-tree
   Portal/modal/drawer mounted outside the known container, or a Tier 1 probe
   proving target invalidation that cannot be resolved locally; **AND**
2. **Direct impact on the next target**: The next operation target lives inside
   that newly rendered or structurally reshaped unknown region and has no
   verified stable selector yet.

**Hard red lines**:

- Never call `DOM.getAXTree` when a local refresh leaves the next target's known
  selector intact.
- Never call `DOM.getAXTree` inside pagination loops or async polling loops.
- When `readText(obs.artifact)` is unavoidable, parse compact fields inside a
  narrow helper scope so the raw string is garbage-collected immediately.
- Cap cross-page concurrency at `<= 8` (`Promise.all` chunks).

## Async convergence matrix

Identify the exact async category during Phase 1 and synthesize the matching
pattern from `references/observation-async-and-options.md`. Never use blind
multi-second `sleep` calls as primary synchronization:

| Async scenario                                          | Runtime trap                                                                                                    | Required Workflow synchronization                                                                                                                                                                                                                                  |
| :------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Full-page navigation & redirects**                 | `Page.navigate` returns on dispatch; SSO/short links emit intermediate loads                                    | `waitFor({ events: ["Page.loaded", "Page.loadFailed"], pageId, timeoutMs, match }, trigger)`; pass `Page.loadFailed` immediately in `match` and throw on failure; match final URL on `Page.loaded`.                                                                |
| **2. SPA in-page routing**                              | `pushState` / hash routing emits `Page.navigate` **without** `Page.loaded`                                      | `waitFor({ events: ["Page.navigate"], pageId, match }, trigger)`, then run a bounded Tier 1 `DOM.getDetails` probe for the new view anchor.                                                                                                                        |
| **3. Local XHR, debounced search & cascading controls** | Debounced inputs (300–800 ms), province -> city selects, and table reloads emit **no Agent event**              | Record `sinceMs = Date.now()` or prior state fingerprint -> dispatch the trigger **once** -> poll with bounded `deadline` + `200–500 ms` `sleep` backoff using `DOM.getDetails`, `DOM.inspectSelect`, or `Network.readApi` (`pendingCount === 0`).                 |
| **4. Portals, animations & virtual lists**              | Popups animate into `document.body`; virtual lists unmount off-screen rows                                      | Confirm `expanded === true` / container state via `DOM.getDetails({ query: { view: "state" } })`; step virtual lists with `Input.scroll` and stop when `completedReason === "boundary-reached"` or `position.y` stops advancing.                                   |
| **5. New tab / popup window**                           | `Page.open` reports `lifecycle: "loading"`, or the new page finishes loading before a second `waitFor` attaches | Capture `newPageId` via `waitFor({ events: ["Page.open"], fleetId }, trigger)`, check `Page.getState({ pageId: newPageId })` first, and only `waitFor(["Page.loaded", "Page.loadFailed"])` if `status === "loading"`.                                              |
| **6. Delayed native dialogs & downloads**               | Validation dialogs open asynchronously; download clicks do not prove transfer completion                        | Check `Input.click` receipt `dialog` / `Page.getState` `blockingInteractions.dialogs` or `waitFor(["Page.dialogOpened"])` -> `Page.handleDialog`; reserve or track downloads and `waitFor(["Download.stateChanged"])` until `completed`, `failed`, or `cancelled`. |

## Selectable component precision (whitelist, blacklist & tie-breaker)

Every native `<select>` and custom listbox/combobox/cascader/menu selection must
follow the 5-step pipeline in `references/observation-async-and-options.md`:

1. **Read live options lightly**: `DOM.inspectSelect` for native selects, or
   bounded `DOM.getDetails` on the open listbox container for custom controls.
2. **Strip non-interactive states**: Exclude `disabled === true` and
   `aria-disabled="true"` options.
3. **Apply Blacklist**: Exclude empty/placeholder items (`""`, `"Select..."`,
   `"请选择"`, `"--"`, unintended `"All"`), embedded management actions
   (`"+ New..."`, `"Create..."`, `"Manage..."`, `"Clear"`, `"Load more"`), and
   task-specific forbidden terms (`"Deprecated"`, `"Disabled"`, `"Sold out"`,
   `"Production"` when targeting staging, etc.).
4. **Apply Whitelist**: Restrict to allowed `values` or normalized `labels` from
   task constants or validated `input` (preferring exact `value` match over
   normalized `label` match).
5. **Enforce cardinality & user-confirmed deterministic tie-breaker**:
   - `0` candidates -> **fail closed** immediately with a descriptive error.
   - `1` candidate -> select deterministically.
   - `> 1` candidates -> apply the **user-confirmed deterministic comparator**
     codified at Gate 1 (for example: exact attribute priority -> lowest numeric
     fee -> latest ISO date -> user-authorized DOM order). Fail closed if no
     tie-breaker was authorized or if the top two candidates still tie
     (`compare(a, b) === 0`).

## Automatic segmentation rules

| Step characteristic                        | Examples                                                                                                                                                     | Required action                                                                                                                                                                         |
| :----------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic rule & controlled choice** | Fixed pagination, known modal dismissal, choice uniquely resolved by blacklist + whitelist + user-confirmed tie-breaker                                      | **Keep inside current segment**                                                                                                                                                         |
| **Agent reasoning boundary**               | Semantic ranking of open search results, summarizing unstructured prose into fields, image/chart interpretation, dynamic candidate choice with no fixed rule | **Split Workflow**: return compact cleaned `candidates` / context in Segment $N$ `output`; let outer Agent decide and pass exact `input` to Segment $N+1$                               |
| **Human judgment or action boundary**      | QR/SMS/MFA/CAPTCHA login, subjective preference pick, irreversible financial/contract/release approval                                                       | **Split Workflow**: finish Segment $N$ cleanly (do not hold a Worker paused across open-ended human wait because `timeoutMs` still ticks); resume with Segment $N+1$ after confirmation |

## Five explicit user confirmation gates

Never batch silent assumptions across gates. Present concise facts and wait for
explicit user confirmation at each applicable gate:

- **Gate 0 — Scope & contract alignment** (before live demo): Start/end state,
  `input`/`output` fields, default Agent-parameterized mode (or explicit
  Dual-Mode request), known option whitelists/blacklists, and `Workflow.list`
  deduplication findings.
- **Gate 1 — Split or tie-breaker confirmation** (on `> 1` valid options or
  judgment/human boundary): Either present the remaining candidates to confirm a
  deterministic tie-breaker vs. splitting, or confirm the segment boundary and
  the `output` -> `input` handoff contract.
- **Gate 2 — Side-effect authorization** (before any real write/mutation during
  demo or L2 replay): Exact target, scope, and payload to submit (or agreement
  to stop cleanly right before final submission).
- **Gate 3 — Segment validation sign-off** (after L1–L3 pass): Duration, total
  platform calls, **`DOM.getAXTree` call count**, async wait strategy, option
  filter/tie-breaker summary, sample `input`/`output`, and current page state.
- **Gate 4 — Workshop persistence & playbook delivery** (before
  `Workflow.upsert`): Segment names (e.g., `[Flow] 01 - Collect Candidates`,
  `[Flow] 02 - Submit Selection`), existing `folderId` (or `null`), `enabled`
  (`false` by default when non-empty `input` is required), and `availability`.
  After `Workflow.upsert`, output the Segmented Orchestration Playbook from
  `references/segmentation-and-validation.md`.

## References

- Read [observation-async-and-options.md](references/observation-async-and-options.md)
  for strictly typed `WorkflowApi` helpers covering Tier 1 probes, guarded
  `DOM.getAXTree` usage, all 6 async convergence patterns, and the 5-step
  whitelist/blacklist/tie-breaker option selector.
- Read [segmentation-and-validation.md](references/segmentation-and-validation.md)
  for multi-segment Agent-parameterized `Input`/`Output` templates, opt-in
  Dual-Mode guards, the L1–L3 audit checklist, CLI `types`/`pack` usage, and the
  Segmented Orchestration Playbook format.
