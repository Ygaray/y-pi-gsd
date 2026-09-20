# Android driver (wired adb) — agentic-tester

Driver playbook for a target surface that is a physical Android device. The `agentic-tester` spine
(`SKILL.md`) resolves this file at its Step 1 "Resolve driver" whenever the surface under test is
Android. This playbook targets one device and one only — the wired tester, tailnet alias
`yahirs-s22-ultra-2` — and every section below exists to make that the structurally unavoidable
outcome rather than a merely requested one.

## Device identity gate

This gate runs fresh before any device-affecting command, in every run — never once per session,
and never from a cached listing.

```bash
TESTER="R5CT10XNKQN"
LISTING=$(adb devices -l)
echo "$LISTING" | grep -qw "$TESTER" || { echo "TESTER_DEVICE_UNAVAILABLE: allowlisted serial $TESTER not present in a fresh adb devices -l listing"; exit 1; }
```

This playbook targets one device and one only: the wired tester serial allowlisted in this gate.
If the allowlisted serial is not present, report the device unavailable and stop; never fall back to whichever device happens to be visible, even when it is the only one.
Never rely on the ANDROID_SERIAL environment variable for targeting; it can carry a stale value from an unrelated session. Every invocation names the serial explicitly with adb -s.
One agent device-tester per rig at a time; if another run holds this device, report and stop rather than driving it concurrently.

The exact-match rule above is not paranoia. The tester and the operator's personal handset are the
same model, their aliases differ by one trailing character, and the two carry different
device-safety regimes — so "the only device currently visible" can silently be the wrong one.

## Preconditions

Spine Step 2, run only after the identity gate above has passed. The device must be awake and
unlocked before any UI-layer claim is driven — a dozing or locked screen produces false failures,
not real ones.

```bash
adb -s "$TESTER" shell dumpsys power | grep -oE 'mWakefulness=[A-Za-z]+'   # want: Awake
adb -s "$TESTER" shell dumpsys trust | grep -oE 'deviceLocked=[01]'        # want: deviceLocked=0
adb -s "$TESTER" shell input keyevent KEYCODE_WAKEUP                       # wake the screen
adb -s "$TESTER" shell svc power stayon true                              # keep it awake for the run
```

A secure keyguard that will not clear is an escalation to the human, not something to work around.

## Build

Spine Step 3. Build the app under test from the current tree with its own documented build
command — this playbook does not own that recipe, since it varies per app under test. Read the
build output rather than assuming success.

```bash
adb -s "$TESTER" install -r <app-debug.apk>                 # -r keeps existing data
# clean schema needed:
adb -s "$TESTER" uninstall <application-id> 2>/dev/null
adb -s "$TESTER" install <app-debug.apk>
adb -s "$TESTER" shell am start -n <application-id>/.<Activity>
```

Driving a previously installed build tests a previous code state and is invalid evidence.

## Drive

Spine Step 4, acting. The single happy path, end to end.

```bash
adb -s "$TESTER" shell uiautomator dump /sdcard/ui.xml >/dev/null
adb -s "$TESTER" pull /sdcard/ui.xml /tmp/ui.xml
# locate the target node by its text or content-desc; bounds = [x1,y1][x2,y2]
# tap the centre: x = (x1+x2)/2, y = (y1+y2)/2
adb -s "$TESTER" shell input tap <x> <y>
adb -s "$TESTER" shell input text "Hello"           # typing
adb -s "$TESTER" shell input keyevent KEYCODE_ENTER # key presses
```

Tap coordinates are recomputed from a fresh dump after any UI change — a layout shift moves the
target, and a stale coordinate lands in dead space.

## Observe

Spine Step 4, evidence. Four capture layers:

```bash
adb -s "$TESTER" shell uiautomator dump /sdcard/ui.xml >/dev/null && adb -s "$TESTER" pull /sdcard/ui.xml /tmp/ui.xml
adb -s "$TESTER" exec-out screencap -p > /tmp/shot.png
adb -s "$TESTER" logcat -c
# ...perform the action...
adb -s "$TESTER" logcat -d | grep -iE "<application-id>|AndroidRuntime|FATAL|Exception" | tail -40
adb -s "$TESTER" shell ls -la /sdcard/Download/
adb -s "$TESTER" pull "/sdcard/Download/<file>" /tmp/
```

- **View hierarchy dump** — the structural read: what elements exist, their text, their bounds.
- **Screen capture** — the rendered read: what the run actually looks like.
- **Logcat, cleared immediately before the action and dumped immediately after** — the real error
  behind a generic UI message.
- **On-device artifact pull** — listing and pulling produced files to the host for byte-level
  inspection.

A user-facing error message is almost never the real cause; the stack trace behind it is in
logcat.

## Evidence layer by claim type

| Claim type | Evidence layer |
|---|---|
| UI structure or displayed-text claim | The view-hierarchy dump |
| Rendered-appearance claim (colour, highlight, image, layout) | The screen capture |
| Crash, error, or background-work claim | Logcat |
| Produced-file or exported-data claim | Pulling the artifact and inspecting it |

Clear logcat immediately before the action and dump it immediately after; a logcat read spanning earlier activity is not evidence for this action.
A hierarchy dump proves structure, not appearance; a rendered claim needs a screen capture you actually read.
"No crash dialog" is the weakest possible signal and settles nothing on its own.

## Airplane mode and restore

Toggling airplane mode is permitted on this wired tester because USB adb survives it. This is a
device-specific allowance, not a general one — it is exactly the rule that does not hold for any
wireless-only handset.

```bash
adb -s "$TESTER" shell cmd connectivity airplane-mode enable
adb -s "$TESTER" shell cmd connectivity airplane-mode disable
adb -s "$TESTER" shell settings get global airplane_mode_on
```

Restore, driven entirely over the wired link:

```bash
adb -s "$TESTER" shell monkey -p com.tailscale.ipn 1     # relaunch tailscale
adb -s "$TESTER" tcpip 1496                              # re-arm the fixed wireless port
adb connect 100.118.21.106:1496                          # reconnect
```

If airplane mode was toggled on at any point in this run, restoring tailscale and wireless adb over the wired adb link is unconditional: it runs on the failure and abort paths exactly as on the success path, and is the last action before the run reports.
Confirm the restore landed — airplane_mode_on reads 0, the tailnet address answers, and the wireless endpoint is listed by adb devices — before the driver considers itself done.

## Gotchas

- The back key pops the whole screen, not just the keyboard, and can eject the run to the
  launcher — dismiss the keyboard by tapping a neutral area instead.
- A layout shift moves tap targets; coordinates are recomputed from a fresh dump rather than
  reused.
- Instrumented test runs clear app data and may uninstall the app — anything driven afterward
  needs a reinstall first.
- There is no usable on-device database shell; a database is pulled to the host and queried
  there.
- The system file picker is a separate app with vendor-specific layouts and is the most brittle
  surface to drive.

Do not drive this device while the operator is actively testing on it.
Toggling airplane mode is permitted on this wired tester only; it is not a general Android rule, and it does not transfer to any wireless-only handset.

## Halt conditions

Four surfaces stop the run, each owned by a specific spine step:

- **The allowlisted serial absent from a fresh device listing** halts at Step 2 via the identity
  gate.
- **A secure keyguard that will not clear** halts at Step 2 and escalates to the human.
- **Another device-tester holding the rig** halts at Step 2.
- **A failing build or install** halts at Step 3.

For each, the run reports the specific condition and stops — it never substitutes another device.

A halt does not skip the restore: if airplane mode was toggled on before the halt, restore tailscale and wireless adb over the wired link before reporting.

A halt at Step 1, 2, or 3 still writes the SELF-UAT log with the halt reason, per the spine's
halt-persistence rule.
