# Changelog

All notable changes are recorded in this file.

## 1.2.2 - 2026-10-25

### Fixed

- Reworked subjective rich-text filling for WangEditor 5 and Slate.
- Added Slate `beforeinput` target ranges based on the active DOM selection.
- Removed direct editor `textContent` and `innerHTML` replacement.
- Added editor character-counter validation.
- Added safer fail-closed behavior when rich-text state cannot be verified.

### Added

- Per-question “clear cache and rethink” action.
- Detailed DeepSeek API setup documentation.
- Publication asset scanning tests for keys, paths, permissions, and metadata.

### Changed

- Restricted userscript network permission to `api.deepseek.com`.
- Removed API-key prefixes from diagnostics.
- Added explicit handling for English-to-Chinese translation questions.

## 1.2.0 - 2026-10-25

### Added

- Single-line and multi-blank fill-in-the-blank support.
- Ordered cloze answer parsing, input-event filling, and per-blank validation.

## 1.1.1 - 2026-10-25

### Added

- Pure-English subjective answers.
- English subjective fast mode.
- Non-English content rejection for English subjective questions.

## 1.1.0 - 2026-10-25

### Added

- Subjective question support for textarea and rich-text editors.
- DeepSeek-only provider preset.
- Improved single, multi, and true/false prompts.

## 1.0.0

- Initial userscript release with single-choice, multiple-choice, answer cache,
  navigation, diagnostics, and DeepSeek configuration.
