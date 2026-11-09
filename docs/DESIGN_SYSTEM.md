# Design system — AutoLemon Armazém (pt-PT)

Owning module: web. Goal: a calm, legible, keyboard- and scanner-first tool for busy auto-parts
counters and warehouses — not a decorative SaaS dashboard.

## 1. Colour tokens (`apps/web/src/styles.css`)

| Token                        | Hex                         | Use                                         |
| ---------------------------- | --------------------------- | ------------------------------------------- |
| paper                        | #F7F8F3                     | app background (warm neutral)               |
| surface                      | #FFFFFF                     | panels, tables, inputs                      |
| ink                          | #202A29                     | primary text, header bar                    |
| ink-soft                     | #4A5654                     | secondary text                              |
| line                         | #DFE4DE                     | dividers, panel borders (decorative)        |
| line-strong                  | #6B7774                     | input/select borders (component boundary)   |
| teal / teal-dark / teal-soft | #246B66 / #1B524E / #E3EFED | actions, links, focus ring, active nav      |
| lemon / lemon-soft           | #E7CC4B / #FAF4D6           | brand accent chip; scanner field background |
| danger / danger-soft         | #A3271F / #FBE9E7           | errors, destructive actions                 |
| ok / ok-soft                 | #1F6B3A / #E4F2E8           | confirmed results                           |

### Measured contrast (WCAG 2.x relative luminance)

| Pair                                   | Ratio         | Requirement                               |
| -------------------------------------- | ------------- | ----------------------------------------- |
| ink on paper                           | 13.81:1       | ≥ 4.5 ✔                                   |
| ink-soft on paper / surface            | 7.15 / 7.64:1 | ≥ 4.5 ✔                                   |
| white on teal (buttons)                | 6.23:1        | ≥ 4.5 ✔                                   |
| teal on surface / paper (links)        | 6.23 / 5.84:1 | ≥ 4.5 ✔                                   |
| teal-dark on teal-soft (active nav)    | 7.55:1        | ≥ 4.5 ✔                                   |
| ink on lemon (brand chip)              | 9.22:1        | ≥ 4.5 ✔                                   |
| ink on lemon-soft (scan field)         | 13.32:1       | ≥ 4.5 ✔                                   |
| danger on danger-soft                  | 6.25:1        | ≥ 4.5 ✔                                   |
| ok on ok-soft                          | 5.64:1        | ≥ 4.5 ✔                                   |
| white on ink (header)                  | 14.74:1       | ≥ 4.5 ✔                                   |
| line-strong on surface (input borders) | 4.65:1        | ≥ 3 (1.4.11) ✔                            |
| line on surface (dividers)             | 1.29:1        | decorative only, not a component boundary |
| lemon on paper                         | 1.50:1        | never used for text                       |

Automated axe-core (WCAG 2.0/2.1/2.2 A+AA rules) checks pass on the login and stock screens
(e2e). Exceptions/unknowns: other screens are not yet axe-scanned (T-10); colour is never the only
carrier of status (pills always include text).

## 2. Typography and spacing

System font stack (no web fonts ⇒ CSP-friendly, fast). Base 15 px; page title 20 px semibold;
tables 14 px with tabular numerals right-aligned (`.num`). Spacing on Tailwind's 4 px scale;
dense tables (6 px vertical cell padding) for operational lists.

## 3. Components (`components/ui.tsx`)

`Page` (title + purpose + numbered workflow steps — every operational screen explains itself),
`Panel`, `Button` (primary/secondary/danger/ghost; disabled while busy), `Field`/`Select`
(visible label bound with `htmlFor`, required marker hidden from AT), `ScanInput`, `Notice`
(`role=alert` for errors, `role=status` for confirmations), `ErrorNotice` (shows validation details
and the request id for support), `Table` (scoped headers), `Pill` (text status), `Barcode`
(Code 128 as SVG rects).

## 4. Keyboard and scanner flows

- Keyboard-wedge scanners: `ScanInput` keeps focus, submits on **Enter**, strips CR/LF, clears
  after each read; lemon-soft background marks "scan here".
- Receiving: choose staging + qty per read → scan repeatedly. Picking: choose reservation → scan
  article to confirm (wrong article ⇒ error, nothing moves). Packing: scan article into a volume.
- All actions reachable by Tab; visible 3 px teal focus ring; "Saltar para o conteúdo" skip link;
  dialogs (step-up) use `role=dialog` + `aria-modal`.
- Never show success unless the API confirmed it; errors keep the user's input.

## 5. Language and tone

pt-PT throughout ("Receção", "Arrumação", "Saídas", "Contagens", "Devoluções"), short imperative
labels, explicit consequences on destructive/sensitive actions (confirmation + MFA step-up).

## 6. Print

`@media print` hides navigation; labels page prints Code 128 labels; dispatch note prints with the
explicit "not a transport document" disclaimer.
