# Inventory editor modal layout verification — 2026-10-10

Supersedes the layout exclusion in the earlier shared-editor report. The user clarified that quick-save comma formatting, rather than the modal layout, was excluded.

Changed application files:
- app/(protected)/inventory/snapshots/page.tsx: centered modal panel, localized item-edit heading, accessible compact close control, fixed header and dedicated scroll body.
- components/inventory/InventoryEditorModal.module.css: maximum 800px width matching the inventory container; 100dvh height limits, responsive gutters, contained scrolling and focus-visible close control.
- components/inventory/InventoryItemEditor.tsx: embedded-only spacing/card/title styles. Standalone inventory page styles and all edit/load/save handlers remain unchanged.
- tests/inventory-snapshots-browser.test.mjs: layout assertions and four screenshots.

Validation:
- 232 related regression tests passed.
- Browser suite passed Korean/Vietnamese x desktop/mobile with intercepted APIs: panel within viewport, width <=800px, fixed header while body scrolls, no horizontal overflow, body scroll lock, localized title and close glyph, identical panel width for banner/history entry, missing-language focus, photo upload/draft preservation, supplier display, success/failure, duplicate saves, warning refresh, cancel, date/filter/scroll preservation, accounting payload, selected-only loading and existing quick-save comma/caret behavior.
- ESLint: no errors or warnings in modified TSX files.
- TypeScript: 40 errors matching the earlier audit, no new errors.
- Visually inspected Korean mobile and Vietnamese desktop screenshots. All four captures are in .qa-review/editor-layout/.

Limitations: browser API responses/photos are fixtures; real production data was not used. Existing TypeScript errors remain. No production DB writes, deployments or Git commands were executed. No accounting, RPC, API, quick-save or canceled-purchase logic was changed.
