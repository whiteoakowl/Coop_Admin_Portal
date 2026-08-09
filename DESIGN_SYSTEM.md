# Design System

This is the source of truth for this application's UI. Before creating,
modifying, or extending any interface, read this file. It documents the
patterns already in use across the app (`public/css/styles.css` and the
`views/` EJS templates) — it doesn't invent anything new, it names what's
already there so it can be reused consistently instead of redrawn
per-page.

There's no component framework here (plain EJS + one shared stylesheet),
so "component" below means a CSS class (or small set of classes) plus the
markup shape that goes with it. Reuse the class and copy the markup shape
from an existing page using it — don't restyle from scratch.

## Core rule

**Do not invent a new visual pattern when an existing one does the job.**
Before building new UI:

1. Search `views/` for a page doing something similar.
2. Check this file for the matching token/component.
3. Reuse it. If it's close but not quite enough, extend it (add a
   modifier class, a new CSS variable) rather than writing a parallel
   one-off.
4. Only if nothing fits: add the new pattern to *this file* in the same
   pass as building it, so the next person (or session) finds it here
   instead of re-inventing it again.

No arbitrary hex colors, one-off `font-size`/`padding`/`border-radius`
values, or bespoke shadows in a page's `<style>` — every visual value
below already has a token or class. If a value you need genuinely isn't
covered, add a token (see "Tokens" below) rather than hardcoding it once.

## Tokens

All defined in `:root` in `public/css/styles.css`. Reference them with
`var(--name)` — never hardcode the resolved value.

**Color**
| Token | Use |
|---|---|
| `--bg` | Page background (outside white cards) |
| `--surface` | Card/panel background |
| `--ink` | Primary text |
| `--muted` | Secondary/label text |
| `--brand`, `--brand-dark`, `--brand-darker`, `--brand-soft` | Logo blue — fills/borders/badges (`--brand`), links/text (`--brand-dark`, never as a button fill), hover (`--brand-darker`), tinted section backgrounds (`--brand-soft`) |
| `--accent`, `--accent-dark` | Highlights, focus rings, admin sidebar |
| `--btn-bg`, `--btn-bg-hover` | **Primary button fill** (orange) — save/add/submit, every page |
| `--btn-green`, `--btn-green-hover` | **File-action button fill** (green) — Import/Export/Print |
| `--btn-purple`, `--btn-purple-hover`, `--purple`, `--purple-dark`, `--purple-soft` | **Secondary toolbar action** — edit/manage/view-toggle. Text is dark-on-tint, not white. |
| `--red`, `--red-bg` | **Destructive actions only** — the one accepted exception to the button-color system above |
| `--green`, `--green-bg` | Success state (present/approved badges, success alerts) |
| `--yellow`, `--yellow-bg`, `--yellow-solid` | Warning/late state |
| `--orange`, `--orange-bg` | Warning-adjacent badges/pills (distinct from `--btn-bg`, which is also orange but is specifically the button fill) |
| `--border` | Card/input/table borders |

Site-wide button color meaning (don't reassign): **orange = primary
action, green = file action (Import/Export/Print), purple = secondary
toolbar action, red = destructive only.** A new button should pick one of
these four, not a new color.

**Shape / elevation**
| Token | Use |
|---|---|
| `--radius` (14px) | Cards, panels, dialogs |
| `--control-radius` (8px) | Inputs, selects, buttons — every interactive control shares this so buttons and fields line up |
| `--shadow-sm` / `--shadow-md` / `--shadow-lg` | Card / raised-card / dialog elevation, in that order |

**Spacing / sizing**
| Token | Use |
|---|---|
| `--card-padding` / `--card-padding-compact` | Page-level card vs. denser supporting card |
| `--control-padding` / `--control-font-size` | Standard, full-size standalone fields (public forms, member edit) |
| `--control-padding-compact` / `--control-font-size-compact` | Inline/toolbar controls (admin action bars, table row actions, dialog buttons) |
| `--logo-xl` … `--logo-2xs` | Named logo sizes per context (sidebar, login, kiosk header, mobile bar) — never a one-off logo pixel size |

## Components

### Buttons

| Class | Fill | When |
|---|---|---|
| `.primary-btn` | orange (`--btn-bg`) | The one committing action on a standalone page/form (Submit, Save) |
| `.btn-secondary` | white, purple border/text | Cancel, or a secondary action next to a primary one |
| `.roster-action-btn` | orange | Toolbar action button on an admin page (compact, flexes to fill a row) |
| `.roster-action-btn-danger` | red | Destructive variant of the above — pair with `data-confirm` (see Dialogs) |
| `.file-action-btn` | green | Import / Export / Print — apply alongside `.btn-secondary` or `.roster-action-btn` as a modifier, not standalone |
| `.print-action-btn` | orange | Print button specifically (see comment in CSS — same fill as primary, separate class only so print buttons can be retargeted independently) |
| `.icon-btn` | icon-only, no fill | Row-level inline actions (remove, move up/down) inside a list/table row |
| `.link-btn` / `.link-btn-danger` | text-only | Lowest-emphasis inline action inside a table cell |

Two buttons doing the same job (Save vs. Save, Delete vs. Delete) must be
the same class, full stop — see `.notes-dialog-actions` in the CSS for
the standard `.primary-btn` + `.btn-secondary` pairing every dialog uses,
sized to match exactly.

### Forms

Standard field shape everywhere: `<label>Field Label<input.../></label>`
(label text and control share one wrapping `<label>`, no separate `for`
juggling). Group fields in a `.member-form-grid` (2-column form) or
`.stack-form` (single column, public-facing forms) — don't build a new
grid wrapper for a form.

- Checkbox/radio groups: `.checkbox-group`/`.radio-group` wrapping
  `.checkbox-option`/`.radio-option` labels.
- Pill-style multi-select (e.g. grade levels): `.grade-pill-grid` +
  `.grade-pill`.
- All inputs/selects/textareas share `--control-radius` /
  `--control-padding` / `--control-font-size` (or the `-compact` variants
  inside a toolbar/dialog) — don't set these directly on a new field.

### Cards

Every card is `--radius` + `--shadow-sm` + `var(--surface)` background +
`var(--border)` border, `--card-padding` (or `-compact`) inside. Specific
named card patterns already exist for: stat/total tiles (`.stat-card`,
`.totals-card`), a person/member row (`.member-card`), a team roster
(`.team-card`, `.team-info-card`, `.team-members-card`), a class
(`.class-card`), a schedule badge (`.schedule-card`). Match an existing
one before adding a new `*-card` class.

### Tables

`.roster-table` (base) + `.condensed-table` (denser rows, admin lists) is
the standard data-table combination — thead with a tinted background,
1px `--border` cell borders. Don't build a bare `<table>` without these.
`.roster-table-detailed` and the page-specific print-table classes
(`.schedule-print-table`, `.members-print-table`, …) exist for print
layouts specifically — see "Print pages" below before adding another.

### Dialogs / modals

Every popup is a native `<dialog>` element, opened via
`showModal()`/`close()` from an inline `onclick` or a small page script —
never a hand-rolled `position: fixed` overlay div. Pick the closest
existing shape:

- `.member-picker-dialog` — a form-only popup (add/create something)
- `.class-view-dialog` — header (icon + title + top-right action
  buttons + close) then a two-column body; used for anything that's
  "view this thing, optionally edit it in place"
- `.notes-dialog` — a single free-text field + Save/Cancel
- `.confirm-dialog` — the sitewide destructive-action confirmation (see
  below)
- `.alert-popup-dialog` (`.alert-popup-success`/`.alert-popup-error`) —
  a single-message, single-OK-button result popup

Action row at the bottom of any dialog: `.notes-dialog-actions` (flex,
right-aligned) wrapping `.primary-btn` + `.btn-secondary`, sized to match
per the CSS comment there — don't size dialog buttons independently.

**Destructive actions:** every delete/remove form site-wide carries
`data-confirm="<message>"` (see `views/partials/confirm-dialog.ejs` +
`public/js/confirm-dialog.js`) instead of a native `confirm()` or a
one-off popup. A JS-triggered submit must call `form.requestSubmit()`,
not `form.submit()`, or the interceptor won't catch it. Any new
delete/remove action must use this pattern — don't add another
`confirm()` call or a bespoke "are you sure" dialog.

### Navigation / tabs

- Admin sidebar: `views/partials/admin-nav.ejs`, one entry per top-level
  section. Full Screen toggle is a fixed top-right corner button on
  every admin page, not a sidebar item.
- Page-level sub-navigation: `.view-tabs` (horizontal tab strip,
  scrolls instead of wrapping so it always fits one line, even on
  tablet/phone widths — don't let a new tab strip wrap instead).
- A binary switch (e.g. Monday/Wednesday): `.day-toggle`
  (slide-toggle look), not a `<select>` — reserve `<select>` for 3+
  options.

### Icons

Inline SVG sprite, defined once in `views/partials/icon-sprite.ejs`,
referenced everywhere as:
```html
<svg class="icon"><use href="#icon-name"/></svg>
```
Add a new icon to the sprite once and reference it by id — never inline
a one-off `<svg>` path in a view, and never pull in an icon font/library.

### Notifications / alerts

- Page-level banner: `.alert.alert-success` / `.alert.alert-error`
  (flash message after a form action, from `?notice=`/`?error=` query
  params — see any admin route for the pattern).
- Dashboard/attendance-page log: `.alert-log-*` classes (Home page's
  Alert Log, or a page's own "Today's Alerts" block) — icon + message
  list, `-danger`/`-warning` modifiers for severity.
- Result/confirmation popup after a public-facing form submit:
  `.alert-popup-dialog` (see Dialogs above).

### Empty states

`.roster-empty` / `.roster-log-empty` / `.team-card-empty` — a single
muted, centered sentence ("No teams yet — create one above.") in place
of an empty list/table/card body. Always point at the action that would
fill it, don't just say "None."

### Component states

Every interactive element needs, at minimum: default, `:hover`,
`:focus`(-visible), and — for anything that can be inactive —
`:disabled`. The existing button/input rules in `styles.css` already
define these for every class above; when extending a class, extend its
`:hover`/`:focus`/`:disabled` rules alongside it, don't leave the
extension state-less. Loading states are handled by full page
navigation/reload (no client-side spinners in this app) — a form submit
that takes a moment doesn't need a spinner component, it needs the
redirect-with-notice pattern every route already uses.

## Responsive behavior

Breakpoints in actual use (add to this list, don't invent a new number
mid-range): `480px`, `500px`, `520px`, `640px`, `720px`, `760px`,
`800px`, `860px`, `900px`, `1100px`, `1400px`. Reuse the nearest existing
one rather than picking a fresh value for a new component, unless the
component's own content genuinely breaks at a different width.

## Print pages

Print views are separate routes/templates (e.g.
`admin-*-print.ejs`) sharing `.print-page` / `.print-header` and a fixed
`@page` size, not the same template with `@media print` overrides. A
print layout that needs to shrink busy content to fit one page uses
`public/js/print-shrink-to-fit.js` against a `*-print-fit` wrapper (see
`class-schedule-print-fit` for the pattern) — don't write a new
shrink-to-fit measurement script per page.

## Typography

`h1` (2rem) is the one page title per page. `h2` (1.15rem) is a section
heading inside a page/card. Don't skip a level or use a `<div>` styled as
a heading — screen readers and the existing CSS both key off the real
tag.

## Accessibility baseline already in place

- Icon-only buttons carry `aria-label` (see `.icon-btn` usage
  everywhere — "Remove Jane Smith", not just "Remove").
- Native `<dialog>` gives focus trapping and Escape-to-close for free —
  don't fight it with a custom modal.
- Native `<select>`/checkbox/radio inputs are used for real
  choices instead of styled `<div>`s, so keyboard/screen-reader behavior
  comes free from the browser.

Keep new UI at this same baseline — a new interactive element needs a
real accessible name (visible text, or `aria-label` if icon-only) before
it's considered done.

## When a new pattern is genuinely needed

1. Confirm nothing above (or in `views/`) already covers it.
2. Build it using existing tokens for every color/spacing/radius/shadow
   value.
3. Add it to this file in the same commit — a new class/component with
   no entry here is incomplete, not just undocumented.
4. Use it everywhere that same need shows up next, rather than letting a
   second one-off appear beside it.
