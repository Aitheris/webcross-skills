# Observation Budget, Async Convergence, and Option Precision

Use these strictly typed `WorkflowApi` patterns when synthesizing Workflow
modules (`src/*.ts`). Every helper below avoids unnecessary `DOM.getAXTree`
calls, uses pure ECMAScript compatible with the QuickJS-NG WASI worker, and
compiles cleanly against `webcross workflow types` (`strict: true`).

## 1. Observation budget & six async convergence helpers

Copy only the helpers required by your segment into `src/helpers.ts` and import
them from `src/main.ts` using a `.js` suffix (`import { ... } from "./helpers.js"`).

```ts
export interface LiveStateMap {
  readonly [key: string]: unknown;
}

/** Tier 1 probe: reads live control state for a known selector without disk artifacts. */
export async function readLiveState(
  api: WorkflowApi,
  selector: string,
  purpose: string,
  pageId?: string,
): Promise<LiveStateMap | null> {
  const result = await api.actions.DOM.getDetails({
    pageId,
    query: { view: "state", targets: [{ selector }] },
    purpose,
  });
  if (result.source !== "live") return null;
  const detail = result.details[0];
  if (!detail || !detail.ok) return null;
  if (
    typeof detail.value !== "object" ||
    detail.value === null ||
    Array.isArray(detail.value)
  ) {
    return null;
  }
  return detail.value;
}

/** Tier 1 batch probe: reads rendered text for up to 64 known selectors in one call. */
export async function readLiveTextBatch(
  api: WorkflowApi,
  selectors: readonly string[],
  purpose: string,
  pageId?: string,
): Promise<(string | null)[]> {
  if (selectors.length === 0) return [];
  const result = await api.actions.DOM.getDetails({
    pageId,
    query: {
      view: "text",
      targets: selectors.slice(0, 64).map((selector) => ({ selector })),
      textMode: "rendered",
    },
    purpose,
  });
  return result.details.map((item) =>
    item.ok && "value" in item && typeof item.value === "string"
      ? item.value.trim()
      : null,
  );
}

/**
 * Tier 2 guarded observation: call ONLY when a structural side effect reshaped the page
 * AND the next operation target resides inside that unknown region.
 * Scopes `rawText` narrowly so the 64 MiB QuickJS heap releases it immediately.
 */
export async function captureStructuralMatchesOnce(
  api: WorkflowApi,
  linePattern: RegExp,
  purpose: string,
  pageId?: string,
): Promise<{ version: string; matchedLines: string[] }> {
  const obs = await api.actions.DOM.getAXTree({ pageId, purpose });
  if (obs.freshness === "unavailable") {
    throw new Error(`Full observation unavailable: ${obs.reason}`);
  }
  let matchedLines: string[] = [];
  {
    const rawText = await api.readText(obs.artifact);
    matchedLines = rawText
      .split("\n")
      .filter((line) => linePattern.test(line))
      .slice(0, 50);
  }
  return { version: obs.version, matchedLines };
}

/** Async Pattern 1: Full-page navigation and multi-hop redirects. */
export async function navigateAndSettle(
  api: WorkflowApi,
  url: string,
  expectedUrlSubstring: string,
  purpose: string,
  pageId?: string,
): Promise<string> {
  const targetPageId = pageId ?? api.context.pageId;
  const settled = await api.waitFor(
    {
      events: ["Page.loaded", "Page.loadFailed"],
      pageId: targetPageId,
      timeoutMs: 25_000,
      match: (event) =>
        event.event === "Page.loadFailed" ||
        event.payload.url.includes(expectedUrlSubstring),
    },
    () => api.actions.Page.navigate({ pageId: targetPageId, url, purpose }),
  );
  if (settled.event.event === "Page.loadFailed") {
    throw new Error(
      `Navigation failed (${settled.event.payload.failure.code}): ${settled.event.payload.failure.message}`,
    );
  }
  return settled.event.payload.url;
}

/** Async Pattern 2: SPA pushState/hash routing (`Page.navigate` fires without `Page.loaded`). */
export async function triggerSpaRouteAndWaitAnchor(
  api: WorkflowApi,
  trigger: () => Promise<unknown>,
  expectedRoutePart: string,
  anchorSelector: string,
  purpose: string,
  pageId?: string,
): Promise<void> {
  const targetPageId = pageId ?? api.context.pageId;
  await api.waitFor(
    {
      events: ["Page.navigate"],
      pageId: targetPageId,
      timeoutMs: 10_000,
      match: (event) => (event.payload.url ?? "").includes(expectedRoutePart),
    },
    trigger,
  );
  const deadline = Date.now() + 8_000;
  let delayMs = 200;
  while (Date.now() < deadline) {
    const anchor = await readLiveState(
      api,
      anchorSelector,
      purpose,
      targetPageId,
    );
    if (anchor !== null) return;
    await api.sleep(delayMs);
    delayMs = Math.min(500, delayMs + 100);
  }
  throw new Error(`SPA route anchor did not become ready: ${anchorSelector}`);
}

/**
 * Async Pattern 3: Local XHR / debounced autocomplete / cascading controls.
 * Dispatches the trigger once, then polls `Network.readApi` and a Tier 1 selector probe.
 */
export async function triggerAndConvergeLocalAsync(
  api: WorkflowApi,
  trigger: () => Promise<unknown>,
  urlPattern: string,
  readySelector: string,
  purpose: string,
  pageId?: string,
): Promise<void> {
  const sinceMs = Date.now();
  await trigger();
  const deadline = Date.now() + 10_000;
  let delayMs = 250;
  while (Date.now() < deadline) {
    const net = await api.actions.Network.readApi({
      pageId,
      sinceMs,
      urlPattern,
      limit: 20,
      purpose,
    });
    const apiSettled =
      net.apis.length > 0 &&
      net.pendingCount === 0 &&
      net.apis.every((entry) => entry.finished);
    if (apiSettled) {
      const target = await readLiveState(api, readySelector, purpose, pageId);
      if (target !== null && target.disabled !== true) return;
    }
    await api.sleep(delayMs);
    delayMs = Math.min(500, delayMs + 125);
  }
  throw new Error(
    `Local async update did not converge for ${urlPattern} -> ${readySelector}`,
  );
}

/** Async Pattern 4a: Expand an overlay/Portal trigger and confirm live readiness. */
export async function expandPopupAndConfirm(
  api: WorkflowApi,
  triggerSelector: string,
  popupSelector: string,
  purpose: string,
  pageId?: string,
): Promise<void> {
  await api.actions.Input.click({ pageId, selector: triggerSelector, purpose });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const probe = await api.actions.DOM.getDetails({
      pageId,
      query: {
        view: "state",
        targets: [{ selector: triggerSelector }, { selector: popupSelector }],
      },
      purpose,
    });
    if (probe.source === "live") {
      const triggerDetail = probe.details[0];
      const popupDetail = probe.details[1];
      const expanded =
        triggerDetail?.ok === true &&
        typeof triggerDetail.value === "object" &&
        triggerDetail.value !== null &&
        !Array.isArray(triggerDetail.value) &&
        triggerDetail.value.expanded === true;
      if (expanded || popupDetail?.ok === true) return;
    }
    await api.sleep(200);
  }
  throw new Error(
    `Popup did not open for ${triggerSelector} -> ${popupSelector}`,
  );
}

/** Async Pattern 4b: Progressive virtual-list scrolling with boundary detection. */
export async function scrollContainerUntilRowMatch(
  api: WorkflowApi,
  containerSelector: string,
  rowSelectors: readonly string[],
  expectedText: string,
  purpose: string,
  pageId?: string,
): Promise<string> {
  let previousY: number | undefined;
  for (let step = 0; step < 20; step += 1) {
    const texts = await readLiveTextBatch(api, rowSelectors, purpose, pageId);
    const hitIndex = texts.findIndex(
      (text) => text !== null && text.includes(expectedText),
    );
    if (hitIndex >= 0) return rowSelectors[hitIndex];

    const scrolled = await api.actions.Input.scroll({
      pageId,
      container: { selector: containerSelector },
      deltaY: 480,
      purpose,
    });
    const currentY = scrolled.position?.y;
    if (
      scrolled.completedReason === "boundary-reached" ||
      scrolled.completedReason === "no-progress" ||
      (previousY !== undefined &&
        currentY !== undefined &&
        currentY === previousY)
    ) {
      break;
    }
    previousY = currentY;
  }
  throw new Error(
    `Target row "${expectedText}" not found in ${containerSelector}`,
  );
}

/** Async Pattern 5: Race-safe newly opened tab/popup synchronization. */
export async function openNewPageRaceSafe(
  api: WorkflowApi,
  trigger: () => Promise<unknown>,
  purpose: string,
): Promise<string> {
  const opened = await api.waitFor(
    {
      events: ["Page.open"],
      fleetId: api.context.fleetId,
      timeoutMs: 10_000,
    },
    trigger,
  );
  const newPageId = opened.event.payload.pageId;
  const state = await api.actions.Page.getState({ pageId: newPageId, purpose });
  if (state.status === "failed" || state.status === "crashed") {
    throw new Error(`Newly opened page ${newPageId} entered ${state.status}`);
  }
  if (state.status === "loading") {
    const settled = await api.waitFor({
      events: ["Page.loaded", "Page.loadFailed"],
      pageId: newPageId,
      timeoutMs: 20_000,
    });
    if (settled.event.event === "Page.loadFailed") {
      throw new Error(settled.event.payload.failure.message);
    }
  }
  return newPageId;
}

/** Async Pattern 6: Reserve a page-initiated download and wait for its terminal state. */
export async function reserveAndAwaitDownload(
  api: WorkflowApi,
  savePath: string,
  trigger: () => Promise<unknown>,
  purpose: string,
  pageId?: string,
): Promise<{ downloadId: string; savePath: string }> {
  const reservation = await api.actions.Download.start({
    pageId,
    savePath,
    overwrite: true,
    purpose,
  });
  const finished = await api.waitFor(
    {
      events: ["Download.stateChanged"],
      timeoutMs: 60_000,
      match: (event) =>
        event.payload.downloadId === reservation.downloadId &&
        (event.payload.currentState === "completed" ||
          event.payload.currentState === "failed" ||
          event.payload.currentState === "cancelled"),
    },
    trigger,
  );
  if (finished.event.payload.currentState !== "completed") {
    throw new Error(
      `Download ${reservation.downloadId} ended as ${finished.event.payload.currentState}: ${finished.event.payload.errorMessage ?? "unknown"}`,
    );
  }
  return { downloadId: reservation.downloadId, savePath: reservation.savePath };
}

/** Resource guard: always stop automatic mouse movement inside `finally`. */
export async function withScopedAutoMove<T>(
  api: WorkflowApi,
  containerSelector: string,
  purpose: string,
  work: () => Promise<T>,
  pageId?: string,
): Promise<T> {
  await api.actions.Input.move({
    pageId,
    auto: true,
    container: { selector: containerSelector },
    intervalMs: 3_000,
    purpose,
  });
  try {
    return await work();
  } finally {
    await api.actions.Input.move({ pageId, auto: false, purpose });
  }
}
```

## 2. Five-step option precision pipeline (whitelist, blacklist & tie-breaker)

Never choose an arbitrary index when filtering selectable components. During
Phase 1, inspect the live option set and construct an `OptionFilterPolicy`. If
`> 1` candidates remain valid, stop at **Gate 1** and obtain explicit user
approval for a `DeterministicTieBreaker` (or split the Workflow).

```ts
export interface ChoiceCandidate {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly ariaDisabled?: boolean;
  readonly selector?: string;
  readonly index: number;
}

export interface DeterministicTieBreaker {
  /** Human-confirmed rule recorded for Gate 1 / Gate 3 auditability. */
  readonly description: string;
  /** Standard comparator: negative if `left` wins over `right`, 0 on tie. */
  readonly compare: (left: ChoiceCandidate, right: ChoiceCandidate) => number;
}

export interface OptionFilterPolicy {
  /** Allowed exact option values (checked first when non-empty). */
  readonly whitelistValues?: readonly string[];
  /** Allowed normalized option labels (case-insensitive trimmed equality). */
  readonly whitelistLabels?: readonly string[];
  /** Explicitly excluded option values. */
  readonly blacklistValues?: readonly string[];
  /** Case-insensitive label substrings to exclude (e.g., "deprecated", "prod", "sold out"). */
  readonly blacklistLabelTerms?: readonly string[];
  /** Permit "all" / "全部" options only when explicitly intended. Defaults to false. */
  readonly allowAllOption?: boolean;
  /** User-confirmed tie-breaker required whenever > 1 valid candidates remain. */
  readonly tieBreaker?: DeterministicTieBreaker;
}

const PLACEHOLDER_LABELS = new Set([
  "",
  "--",
  "---",
  "select",
  "select...",
  "please select",
  "choose...",
  "none",
  "请选择",
  "请选择...",
  "選択してください",
  "선택하세요",
]);

const ALL_OPTION_LABELS = new Set([
  "all",
  "all items",
  "全部",
  "すべて",
  "전체",
]);

const EMBEDDED_ACTION_PREFIXES = [
  "+ ",
  "＋",
  "create ",
  "new ",
  "add ",
  "manage ",
  "clear",
  "load more",
  "新建",
  "新增",
  "管理",
  "清除",
  "加载更多",
];

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

function isBlacklistedOption(
  candidate: ChoiceCandidate,
  policy: OptionFilterPolicy,
): boolean {
  const rawValue = candidate.value.trim();
  const normLabel = normalizeLabel(candidate.label);
  if (rawValue.length === 0 && normLabel.length === 0) return true;
  if (PLACEHOLDER_LABELS.has(normLabel)) return true;
  if (!policy.allowAllOption && ALL_OPTION_LABELS.has(normLabel)) return true;
  if (EMBEDDED_ACTION_PREFIXES.some((prefix) => normLabel.startsWith(prefix))) {
    return true;
  }
  if (policy.blacklistValues?.includes(rawValue)) return true;
  if (
    policy.blacklistLabelTerms?.some((term) =>
      normLabel.includes(term.trim().toLowerCase()),
    )
  ) {
    return true;
  }
  return false;
}

function matchesWhitelist(
  candidate: ChoiceCandidate,
  policy: OptionFilterPolicy,
): boolean {
  const hasValueList =
    policy.whitelistValues !== undefined && policy.whitelistValues.length > 0;
  const hasLabelList =
    policy.whitelistLabels !== undefined && policy.whitelistLabels.length > 0;
  if (!hasValueList && !hasLabelList) return true;

  if (hasValueList && policy.whitelistValues!.includes(candidate.value)) {
    return true;
  }
  if (hasLabelList) {
    const norm = normalizeLabel(candidate.label);
    const allowedLabels = new Set(
      policy.whitelistLabels!.map((item) => normalizeLabel(item)),
    );
    if (allowedLabels.has(norm)) return true;
  }
  return false;
}

/**
 * Pure 5-step option resolver:
 * 1. Receives live options -> 2. Strips disabled -> 3. Applies blacklist ->
 * 4. Applies whitelist -> 5. Enforces cardinality + user-confirmed tie-breaker.
 */
export function selectChoiceDeterministically(
  rawOptions: readonly ChoiceCandidate[],
  policy: OptionFilterPolicy,
): ChoiceCandidate {
  const enabled = rawOptions.filter(
    (item) => !item.disabled && !item.ariaDisabled,
  );
  const clean = enabled.filter((item) => !isBlacklistedOption(item, policy));
  const matching = clean.filter((item) => matchesWhitelist(item, policy));

  if (
    policy.whitelistValues &&
    policy.whitelistValues.length === 1 &&
    matching.length > 1
  ) {
    const exactValueHits = matching.filter(
      (item) => item.value === policy.whitelistValues![0],
    );
    if (exactValueHits.length === 1) return exactValueHits[0];
  }

  if (matching.length === 0) {
    const preview = clean
      .slice(0, 8)
      .map((item) => `${item.label} (${item.value})`)
      .join(", ");
    throw new Error(
      `Option filter matched 0 valid candidates. Remaining clean options: [${preview}]`,
    );
  }
  if (matching.length === 1) return matching[0];

  if (!policy.tieBreaker) {
    const summary = matching
      .slice(0, 8)
      .map((item) => `${item.label} (${item.value})`)
      .join(", ");
    throw new Error(
      `Ambiguous selection (${matching.length} valid candidates: [${summary}]) without a user-confirmed tieBreaker.`,
    );
  }

  const ranked = [...matching].sort(policy.tieBreaker.compare);
  if (policy.tieBreaker.compare(ranked[0], ranked[1]) === 0) {
    throw new Error(
      `Tie-breaker "${policy.tieBreaker.description}" tied between "${ranked[0].label}" and "${ranked[1].label}".`,
    );
  }
  return ranked[0];
}

/** Native `<select>` precision helper: `DOM.inspectSelect` -> 5-step filter -> `Input.select`. */
export async function selectNativeOptionSafely(
  api: WorkflowApi,
  selector: string,
  policy: OptionFilterPolicy,
  purpose: string,
  pageId?: string,
): Promise<{ value: string; label: string }> {
  const inspected = await api.actions.DOM.inspectSelect({
    pageId,
    selector,
    purpose,
  });
  if (inspected.type !== "select") {
    throw new Error(
      `Expected native <select> at ${selector}, got ${inspected.type}`,
    );
  }
  const candidates: ChoiceCandidate[] = inspected.options.map((opt, index) => ({
    value: opt.value,
    label: opt.label,
    disabled: opt.disabled || opt.value.trim().length === 0,
    index,
  }));
  const winner = selectChoiceDeterministically(candidates, policy);
  const committed = await api.actions.Input.select({
    pageId,
    id: inspected.controlId,
    selector,
    selections: [{ value: winner.value }],
    purpose,
  });
  if (committed.type !== "select" || committed.selected.length === 0) {
    throw new Error(`Native select commit did not confirm "${winner.value}"`);
  }
  return {
    value: committed.selected[0].value,
    label: committed.selected[0].label,
  };
}

/** Custom listbox/combobox helper using bounded Tier 1 batch queries (zero `DOM.getAXTree`). */
export async function selectCustomOptionSafely(
  api: WorkflowApi,
  optionSelectors: readonly string[],
  policy: OptionFilterPolicy,
  purpose: string,
  pageId?: string,
): Promise<{ selector: string; label: string; value: string }> {
  const targets = optionSelectors
    .slice(0, 64)
    .map((selector) => ({ selector }));
  const [textsRes, attrsRes] = await Promise.all([
    api.actions.DOM.getDetails({
      pageId,
      query: { view: "text", targets, textMode: "rendered" },
      purpose,
    }),
    api.actions.DOM.getDetails({
      pageId,
      query: {
        view: "attributes",
        targets,
        attributes: ["data-value", "value", "aria-disabled", "disabled"],
      },
      purpose,
    }),
  ]);

  const candidates: ChoiceCandidate[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const textItem = textsRes.details[index];
    const attrItem = attrsRes.details[index];
    if (!textItem?.ok) continue;
    const label =
      "value" in textItem && typeof textItem.value === "string"
        ? textItem.value.trim()
        : "";
    const attrMap =
      attrItem?.ok &&
      "value" in attrItem &&
      typeof attrItem.value === "object" &&
      attrItem.value !== null &&
      !Array.isArray(attrItem.value)
        ? attrItem.value
        : {};
    const rawVal =
      typeof attrMap["data-value"] === "string"
        ? attrMap["data-value"]
        : typeof attrMap.value === "string"
          ? attrMap.value
          : label;
    const ariaDisabled = attrMap["aria-disabled"] === "true";
    const disabled =
      attrMap.disabled !== undefined && attrMap.disabled !== null;
    candidates.push({
      value: rawVal,
      label,
      disabled,
      ariaDisabled,
      selector: targets[index].selector,
      index,
    });
  }

  const winner = selectChoiceDeterministically(candidates, policy);
  if (!winner.selector) {
    throw new Error(
      "Resolved custom option candidate is missing its selector.",
    );
  }
  await api.actions.Input.click({ pageId, selector: winner.selector, purpose });
  return {
    selector: winner.selector,
    label: winner.label,
    value: winner.value,
  };
}
```
