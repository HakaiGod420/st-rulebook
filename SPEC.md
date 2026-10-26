# Rulebook — spec

A SillyTavern extension that holds **behavioural rules** — instructions to the model
about *how* it writes and *what the characters do* — as a library of small, individually
toggleable rules, grouped into switchable rulebooks, with per-chat overrides and an AI
authoring layer.

Not a World Info replacement. World Info carries **facts**. Rulebook carries
**instructions**. Any overlap in the UI language is a bug, so the extension never shows
the words "lore", "entry" or "keyword".

## Why

People accumulate prompt fragments across notes, Discord, and half-edited character
cards: "she falls for him instantly", "never end a scene without a hook", "no
purple prose". Today those are copy-pasted into the Author's Note, one blob at a time,
with no idea what they cost in context and no way to turn one off for one chat.

Rulebook makes each fragment a first-class object with a switch.

## Objects

### Rule

| field | type | notes |
|---|---|---|
| `id` | string | `r` + timestamp + random |
| `label` | string ≤80 | shown in the list; derived from the text when omitted |
| `text` | string ≤4000 | the instruction itself |
| `category` | enum | `romance`, `drama`, `conflict`, `world`, `style`, `meta` |
| `strength` | enum | `hard` → rendered as "Always:", `soft` → "Prefer:" |
| `group` | string ≤40 | optional contested topic, e.g. `romance pace` |
| `stance` | string ≤40 | this rule's position in that topic, e.g. `instant` |
| `tags` | string[] ≤8 | free-form, searchable |
| `pinned` | bool | shown in the in-chat HUD |
| `enabled` | bool | the global switch |
| `source` | `hand` \| `ai` | provenance, shown as a badge |

`group` + `stance` is the conflict system: two enabled rules with the **same group and a
different stance** contradict each other, and the Compose tab names both. No fake
weights, no scoring.

### Rulebook

A named selection: `{ id, name, note, ruleIds[], updatedAt }`. Applying a book writes
the global `enabled` flags — `replace` turns its members on and everything else off;
`add` only turns members on. Books are presets, not a third parallel state, so there is
only ever one thing to reason about.

### Per-chat override

`chatMetadata['st-rulebook'].overrides = { [ruleId]: boolean }` — a sparse map on top of
the global flags. It travels with the chat file because ST writes chat metadata into the
chat, so "this one chat wants instant-love even though the library has it off" survives
a reload and a share.

Effective state = `overrides[id] ?? rule.enabled`.

## Injection

One composed block, via `setExtensionPrompt(INJECT_KEY, text, position, depth, false, role)`.

- Default position `IN_PROMPT` (0) — rules are static, so keeping them in the prefix
  keeps the prompt cache warm. `IN_CHAT` (1) + depth and `BEFORE_PROMPT` (2) are offered
  for people who want the rules to sit closer to the last message.
- Composition groups by category in fixed order, hard rules before soft ones, template
  wraps it with a header. `{{rules}}` is the placeholder; `{{char}}` / `{{user}}` inside
  rule text are substituted at compose time.
- **Empty selection must clear the key.** A `setExtensionPrompt(key, '')` runs whenever
  the composed text is empty and on `CHAT_CHANGED`, or one chat's rules leak into the
  next.
- Toggling any rule invalidates the prompt cache from that point on — the panel says so
  next to the token meter instead of pretending otherwise.

## Scope (v1)

In: global library, per-chat overrides, rulebooks, compose preview, token meter,
conflict warnings, AI author / atomize / remix, import & export, slash commands, HUD.

Out (deliberate): world facts, per-character rulebooks bundled into cards, keyword
triggers, post-generation text scrubbing, AI dedupe of the whole library. Each is
listed in the roadmap; none of them is half-built in the shipped code.

## UI map

- **Settings drawer** — master switch, live token readout, one button into the modal.
- **Wand menu** — same modal.
- **Modal**
  - *Rules*: search, category filter, rows with global switch, per-chat override chip,
    pin, edit, duplicate, delete, reorder. Editor is a sub-view, not an inline expander.
  - *Sets*: rulebooks with Apply / Add / Save current / Delete / Rename.
  - *Compose*: the exact injected text, token count, share of context, conflicts,
    copy button, injection position + depth + template.
  - *Author*: describe (or paste text) → AI returns atomic rules → tick the ones to keep.
    Remix a rule into softer/harder variants from any rule row.
- **HUD** — a chip above the send form showing the active count; expands to toggle
  pinned rules mid-scene. Hidden when nothing is pinned.

## Slash commands

```
/rules                      list effective rules with counts
/rule <label|id> on|off|toggle
/rulebook <name>            apply (replace)
/rulebook add <name>        apply additively
/rulebook save <name>       save the current selection as a book
```

## Ground rules for the build

1. No SillyTavern import in `src/rules.js` or `src/ui.js` — the harness loads them as
   plain modules, so the same code is testable outside ST.
2. Every write goes through `saveSettingsDebounced` or `saveMetadataDebounced`.
3. Theme variables only; all selectors under `.rb-root` / `.rb-hud`.
4. Geometry tested at 390 / 820 / 1280 px in both themes, with `#send_form` present.
