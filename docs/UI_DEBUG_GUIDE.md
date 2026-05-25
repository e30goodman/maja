# UI Debugging: The Traffic Light Method

## 🚫 Anti-Patterns (NEVER DO THIS)
When fixing alignment or spacing in Flex/Grid layouts, NEVER use:
- `transform: translateX` or `translateY`
- Magic pixel offsets (`right: -20px`)
- Fake/invisible extension layers

## 🚦 The Traffic Light Method
To find which container is breaking the layout, apply these temporary Tailwind borders to the DOM hierarchy:

1. **Reference/Root (Red):** `border-2 border-red-500 z-50`
   *(Apply to the correct baseline element, e.g., Header or Main Screen Wrapper)*
2. **Parent Container (Green):** `border-2 border-green-500 z-40`
   *(Apply to the wrapper holding the broken items, e.g., Scroll area, Grid wrapper)*
3. **Target Element (Yellow):** `border-2 border-yellow-500 z-30`
   *(Apply to the specific row/bar that is misaligned)*
4. **Inner Children (Blue):** `border-2 border-blue-500 z-20`
   *(Apply to the cells/buttons inside the Target Element)*

## 🔍 How to Analyze the Screenshot
1. **Yellow doesn't reach the edge of Green?** -> The problem is the Target Element. Fix its `width` or `flex-grow`.
2. **Green edge doesn't align with Red edge?** -> The problem is the Parent Container. Check for restrictive `padding`, `margin`, or `max-width`.
3. **Blue items are stretching/squishing incorrectly?** -> The problem is how the Yellow Target manages children. Fix `justify-content`, `align-items`, or `flex-basis`.

**Rule of Thumb:** Fix ONLY the specific layer where the border breaks the expected behavior.
