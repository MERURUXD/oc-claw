# oc-claw agent entry point

Follow the shared repository rules in [AGENTS.md](AGENTS.md).

For a specific investigation, consult only the relevant section of the [historical implementation notes](docs/development/historical-implementation.md):

- Session monitoring and integrations: efficiency-mode popups, Codex/Cursor integration, OpenClaw data formats, and session watcher sections.
- Polling and remote access: polling/SSH and Windows SSH sections.
- Presentation bugs: video transitions and Windows window-management, asset-loading, and audio sections.
- Platform hooks: Windows hooks and session-file-path sections.
- Media conversion or updater history: conversion and update/release sections; current workflows define publishing behavior.

These notes are optional historical context, not a startup reading checklist or instructions to restore old behavior. Verify relevant details against current code and tests.
