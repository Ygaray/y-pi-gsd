# Browser driver — agentic-tester

## Preconditions

- The `browser-tools` extension is enabled and its tools are callable in this session. The
  extension manifest at `src/resources/extensions/browser-tools/extension-manifest.json` declares
  `requires.platform` at `>=2.29.0`, so the running pi-coding-agent platform version must satisfy
  that floor. Check via `/gsd extensions info browser-tools` or `/gsd doctor`; if the platform
  version does not satisfy the floor, halt and report rather than driving anyway.
- The target URL is reachable and is serving the build under test.
- This run never substitutes a different URL, a different port, or an already-open page for one
  that is unavailable. An unavailable target is reported and the run halts — it is not worked
  around.

## Build

- The page under test is served from the current tree, not from a stale process left running from
  an earlier session.
- Build and start the target app per its own documented command. Read the startup output rather
  than assuming success — the process exiting immediately or logging a bind error is a build
  blocker, not a green light.
- Confirm the served build corresponds to the current code state before navigating to it.
- Navigating to a previously-running server that was started from older code is testing a previous
  code state, and evidence captured against it is invalid.

## Drive

All interaction goes through the registered `browser-tools` extension tool names — never a
hand-rolled browser-automation script, and never a shelled-out browser binary. The tool names are
the entire browser surface this driver uses.

One complete happy path, navigate to close:

1. `browser_navigate` to the target URL.
2. `browser_wait_for` on the condition that means the page is actually ready to interact with —
   never a fixed delay. Never use `condition: "network_idle"` — it hangs indefinitely against dev
   servers that keep persistent connections open (Vite HMR, WebSocket). Prefer `selector_visible`
   or `text_visible`; use `delay` only as a last resort.
3. The interaction tool that matches the control under test:
   - `browser_click` for buttons and links
   - `browser_type` for text inputs
   - `browser_key_press` for keyboard-driven behaviour
   - `browser_select_option` for `<select>` controls
   - `browser_set_checked` for checkboxes and radios
   - `browser_scroll` to bring an off-viewport target into view before acting on it
4. `browser_close` to end the session once every criterion against this page has its evidence.

Every interaction is followed by an observation drawn from `## Observe` — an action with no
observation produces no evidence, and an unobserved action cannot support a verdict.

## Observe

Three evidence layers, each produced by its own tool set:

- **Log, request, and status-code evidence** — `browser_get_console_logs` and
  `browser_get_network_logs`.
- **DOM and application-state evidence** — `browser_get_accessibility_tree`,
  `browser_get_page_source`, and `browser_evaluate`.
- **Rendered-appearance evidence** — `browser_screenshot`.

## Evidence layer by claim type

This is a rule, not a passive aside — every claim type resolves to exactly one evidence layer:

| Claim type | Evidence layer |
|------------|-----------------|
| Log, request, status-code, and error claims | `browser_get_console_logs`, `browser_get_network_logs` |
| DOM, content, and application-state claims | `browser_get_accessibility_tree`, `browser_get_page_source`, or `browser_evaluate` |
| Rendered-appearance claims — layout, colour, spacing, image rendering, visual regression | `browser_screenshot`, and only those |

Reserve browser_screenshot for genuinely visual, rendered claims; a screenshot for a non-visual claim is expensive, lossy, and harder to grep.
A DOM dump proves structure, not what is actually rendered; a genuinely visual claim needs a screenshot you actually read.
The cheapest sufficient layer is never zero layers — every verdict needs an evidence layer.

## Gotchas

browser_evaluate is for reading page state only; drive every state change through a real interaction tool, never by evaluating a mutation.
Redact Authorization and Cookie header values, Set-Cookie values, and query-string credentials out of captured network and console evidence before it enters the SELF-UAT log.
Navigating to a server started from older code tests a previous code state and is invalid evidence.

An interaction against an element that has not settled yet produces a false failure — wait on a
readiness condition (via `browser_wait_for`) rather than on a fixed delay before interacting.

The accessibility tree is the cheaper first read for a content or state claim; reserve the full
page source for when the structure the criterion actually turns on lives outside the accessibility
tree.

## Halt conditions

Three surfaces stop the run, each owned by a specific spine step:

- **The browser extension is unavailable, or the running platform version is below the manifest's
  `>=2.29.0` floor** — halts at Step 2 (Preflight).
- **The target URL is unreachable** — halts at Step 2 (Preflight).
- **The app under test fails to build or fails to serve** — halts at Step 3 (Build).

For each of these, the run reports the specific missing precondition and stops — it never
substitutes a different URL, a different port, or an already-running server for the one that
failed. A halt at Step 1, 2, or 3 still writes the SELF-UAT log with the halt reason, per the
spine's halt-persistence rule.
