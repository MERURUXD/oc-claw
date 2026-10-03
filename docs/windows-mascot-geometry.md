# Windows mascot geometry

Collapsed mascots use the target monitor's Windows work area as their lower
movement boundary. A bottom auto-hide taskbar reserves its full native height
even when retracted. Left/right screen edges remain separate from that floor:
the existing edge probe still exposes 55% of the tilted body and 82% when
straightened, including intentional partial placement outside the screen.

The constraint uses the registered body bounds, not transparent video canvas
padding. During a probe, it uses the swept bounds of the body across the entire
rotation, including intermediate angles. That envelope is reserved before the
first rotated frame, so clicking/returning does not repeatedly shift the floor.
Restoring the normal canvas clears the motion envelope after native probe moves
have drained. Mascots without registered body bounds use their native frame.

Windows drag commands and collapsed canvas/size changes constrain position
before moving. A 200 ms native reconciliation loop also handles taskbar/display
settings and other native frame changes. Expanded panels and settings layouts
are excluded. The bubble follows a corrected primary mascot. Primary, extra,
and demo mascot windows share the floor policy; other platforms retain their
native movement behavior.

## Animation integration interface

`frontend/src/lib/mascotGeometry.ts` exposes:

- `getMascotGeometry(windowLabel)`: the current snapshot, or `null` outside
  Windows or while the primary window has a panel/settings layout.
- `listenMascotGeometry(onChange)`: subscribes to `mascot-geometry-changed` in
  the originating webview; returns the Tauri unsubscribe function.

Snapshots contain the window label, current display identifier, scale factor,
monitor rectangle, usable work area, body rectangle, distances to the left,
right and lower boundaries, and whether an auto-hide taskbar was reserved.
All coordinates/distances are physical screen pixels. Divide by `scaleFactor`
for CSS pixels. The display identifier is session-local. During probing,
`body` represents the conservative swept motion bounds; negative horizontal
distances are valid probe exposure.

No new animation mapping is installed. A future position policy can consume
these observations alongside the existing business/interaction state. It must
not change agent activity, approval, session completion, or probe ownership.

The implementation adapts the work-area/mascot-anchor separation observed in
[decode-codex](https://github.com/JimLiu/decode-codex), using native Windows APIs
for OC-Claw's Tauri runtime.

## Manual Windows validation

- Drag primary and extra mascots down to the taskbar, including 100%, 150%,
  and 200% display scaling; verify the body stays above it.
- Enter left/right probes near the lower corners, click to straighten, wait
  for return, then drag away. Verify exposure and the taskbar floor throughout.
- Repeat with sprite pets and video pets with transparent margins. Change size
  at the floor, and expand/collapse the panel or open/close settings.
- Move between monitors with different DPI and negative origins. Verify each
  target's taskbar height is used, and secondary auto-hide taskbars are reserved.
- Toggle auto-hide, change taskbar dimensions, and disconnect a monitor while
  the pet rests near the floor. Existing off-screen horizontal probe placement
  remains intentional; this version does not add general off-screen recovery.

If the shell cannot report an auto-hide taskbar window, the floor falls back to
the monitor's reported work area, without assuming a fixed taskbar thickness.
