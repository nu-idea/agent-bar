# Changelog

All notable changes to agent-bar. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions: [SemVer](https://semver.org/).

## [0.2.0] - 2026-11-25

### Added
- English interface. Settings → Language: System (follows macOS), English or Русский. Switches without a restart.

### Fixed
- Release files: in 0.1.0 the downloads ended up in a second, hidden release.

## [0.1.0] - 2026-11-25

First public release.

### Added
- Floating pill on top of all windows with counters: working, waiting for you, needs an answer. Drag it anywhere, the position is remembered. Also a menu bar icon.
- Session list for Claude Code (terminal, VS Code, Claude app), Codex and Hermes: status, project, where it runs, context load, subagents, background tasks.
- "Needs an answer" and "Waiting for permission" states when an agent stops mid-turn.
- Sounds when a session finishes or asks something: system sounds or your own from `~/Library/Sounds`, volume, per-session and global mute. No sound for the VS Code window you're looking at.
- Click a card to open where the session runs.
- Rename or hide a session, resize the list, light and dark theme, settings screen and `settings.json`.

### Known limitations
- Not signed with an Apple Developer certificate: macOS blocks the first launch, see README.
- No auto-update yet: check Releases for new versions.
