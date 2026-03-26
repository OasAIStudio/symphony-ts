# Behavior: skill-validation-v1

> Interactive behavior and dynamic state documentation.

## Hover Effects

- **Data table rows**: Background transitions to `#F1F5F9` on hover with `transition: background 150ms ease`.
- **Metric cards**: Subtle `box-shadow` increase on hover (`0 2px 8px rgba(0,0,0,0.08)` → `0 4px 16px rgba(0,0,0,0.12)`).
- **Footer links**: Underline appears on hover.

## Status Indicators

- **Running**: Pulsing green dot (CSS `@keyframes pulse` animation, 2s infinite).
- **Idle**: Static gray dot.
- **Error**: Static red dot.

## Responsive Behavior

- **≥1440px**: Full-width layout, 4-column metric grid.
- **1024–1439px**: 2-column metric grid, table columns collapse "Last Run".
- **<1024px**: Single-column stack, horizontal scroll on data table.

## Sorting

- **Data table**: Column headers are interactive — clicking toggles ascending/descending sort. Active sort column shows a directional arrow indicator.
- Default sort: "Tasks" column, descending.

## Chart Interactivity

- **Tooltip on hover**: Shows exact token count and date for the nearest data point.
- **Legend toggle**: Clicking a series name in the legend toggles its visibility.
