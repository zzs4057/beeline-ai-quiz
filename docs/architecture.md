# Architecture

## Runtime flow

```text
DOM observation
  -> question type detection
  -> question fingerprint and cache lookup
  -> DeepSeek request
  -> response parsing
  -> page interaction
  -> state verification
  -> next-question navigation
```

## Main modules

| Module | Responsibility |
|---|---|
| Configuration | Loads and validates local userscript settings |
| Question parser | Locates the current question box and visible controls |
| Type detector | Distinguishes single, multi, judge, cloze, and subjective |
| AI client | Sends standard chat-completions requests to DeepSeek |
| Answer parser | Extracts option letters, cloze lines, or subjective text |
| Objective handler | Selects options and verifies DOM/framework state |
| Cloze handler | Writes ordered answers into text inputs |
| Subjective handler | Uses editor APIs or Slate-compatible input events |
| Navigation | Finds next/previous controls and waits for stable rendering |
| Cache | Stores fingerprints and successful answers locally |
| Diagnostics | Reports selectors, control types, editor state, and errors |

## Question fingerprints

The fingerprint is a deterministic hash of:

- Question type.
- Stem.
- Option letters and text.

It is used only for local cache lookup. It does not contain account data.

## Rich-text insertion

The subjective handler avoids direct `textContent` or `innerHTML` replacement.
Depending on the detected editor, it may use:

1. A public editor API such as Quill `setText`.
2. Slate/WangEditor `beforeinput` with the active DOM range.
3. A synthetic paste event with a `DataTransfer`.
4. Native editing commands for non-Slate editors.

The handler then checks both visible text and a nearby `current/max` character
counter when available.

## Navigation safety

The script compares stable question fingerprints before and after clicking
next. If the platform has already advanced automatically, it avoids a second
click that would skip a question.

## Failure policy

An answer is never considered successful solely because text is visible. If
selection, editor state, answer count, or navigation cannot be verified, the
script stops with a diagnostic instead of silently continuing.
