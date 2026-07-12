# Custom Glyph Rendering

CanvasTerminal renders certain Unicode character ranges as geometric primitives instead of delegating to font glyphs. This matches the approach used by Alacritty, kitty, WezTerm, and Ghostty — ensuring pixel-perfect alignment regardless of which font is installed.

## Why Custom Rendering

Font-based rendering of structural terminal characters has three problems:

1. **Cell mismatch** — glyph metrics from the fallback font may not match the primary font's cell dimensions, causing gaps or overlap
2. **Height/width fill** — powerline arrows and block elements must fill the entire cell edge-to-edge; `fillText()` renders at the font's natural metrics
3. **Font dependency** — users would need specific "Nerd Font" or "Powerline" font variants installed

Custom rendering eliminates all three: shapes are drawn to exact cell boundaries using Canvas 2D primitives.

## Rendered Ranges

| Range | Count | Description | Drawing Method |
|---|---|---|---|
| U+2500–U+257F | 128 | Box drawing (lines, corners, T-junctions, crosses) | Line segments with light/heavy weights |
| U+2580–U+259F | 32 | Block elements (halves, shades, quadrants) | `fillRect` with opacity for shades |
| U+E0B0–U+E0BF | 16 | Powerline arrows (triangles, semicircles, diagonals) | `beginPath`/`fill` with fg/bg color handling |
| U+2800–U+28FF | 256 | Braille patterns (2×4 dot grid) | Circles via `arc()` |
| U+1FB00–U+1FB3B | 60 | Sextant blocks (2×3 grid) | `fillRect` per active cell |
| U+1FB3C–U+1FB6F | 52 | Smooth mosaic wedges/triangles | Filled polygons |
| U+1FB70–U+1FB8B | 28 | 1/8th block elements | `fillRect` at precise eighths |

Characters outside these ranges fall through to `fillText()` using the configured font.

## Specifications

### Box Drawing (U+2500–U+257F)

Line segments from cell center to edges. Two weights: light (`cellWidth/8`) and heavy (`cellWidth/4`). Includes:
- Single/double lines and corners
- T-junctions and crosses (all light/heavy combinations)
- Rounded corners (╭╮╰╯) — rendered as straight segments (same as light corners)
- Diagonals (╱╲╳)
- Dashed lines — see below

### Dashed Lines

All dashes use **2:1 dash-to-gap ratio** (matching WezTerm spec):

| Codepoints | Type | Segments | Formula |
|---|---|---|---|
| U+2504/05, U+2506/07 | Triple dash (H/V) | 9 units: 3×(2+1) | dash=2/9, gap=1/9 |
| U+2508/09, U+250A/0B | Quadruple dash (H/V) | 12 units: 4×(2+1) | dash=2/12, gap=1/12 |
| U+254C/4D, U+254E/4F | Double dash (H/V) | 6 units: 2×(2+1) | dash=2/6, gap=1/6 |

Drawn as filled rectangles (not `setLineDash`) for pixel precision.

### Block Elements (U+2580–U+259F)

- **Half blocks**: `fillRect` covering half the cell
- **Shades** (░▒▓): full-cell `fillRect` with `globalAlpha` at 0.25, 0.5, 0.75
- **Quadrants** (▖▗▘…▟): `fillRect` for each active quadrant (cell/2 × cell/2)

### Powerline (U+E0B0–U+E0BF)

These handle their own background: first fill the cell with bg color, then draw the shape in fg color. This is necessary because powerline arrows create a visual transition between two differently-colored segments.

| Codepoint | Shape |
|---|---|
| U+E0B0 | Right-pointing filled triangle |
| U+E0B1 | Right-pointing line triangle |
| U+E0B2 | Left-pointing filled triangle |
| U+E0B3 | Left-pointing line triangle |
| U+E0B4/B5 | Right semicircle (filled/line) |
| U+E0B6/B7 | Left semicircle (filled/line) |
| U+E0B8–U+E0BF | Diagonal triangles (8 variants) |

### Braille (U+2800–U+28FF)

2 columns × 4 rows = 8 dots. The low byte of the codepoint IS the dot bitmask (ISO 11548):

```
bit 0 → col 0, row 0  (dot 1)    bit 3 → col 1, row 0  (dot 4)
bit 1 → col 0, row 1  (dot 2)    bit 4 → col 1, row 1  (dot 5)
bit 2 → col 0, row 2  (dot 3)    bit 5 → col 1, row 2  (dot 6)
bit 6 → col 0, row 3  (dot 7)    bit 7 → col 1, row 3  (dot 8)
```

Each dot is a circle with radius `cellWidth/8`, centered within its `(cellWidth/2 × cellHeight/4)` sub-area.

### Sextant Blocks (U+1FB00–U+1FB3B)

2 columns × 3 rows = 6 segments. Each segment is `cellWidth/2 × cellHeight/3`.

Bit-to-position mapping:

```
bit 0 = top-left      bit 1 = top-right
bit 2 = middle-left   bit 3 = middle-right
bit 4 = bottom-left   bit 5 = bottom-right
```

The 60 codepoints cover all 6-bit combinations except: empty (0), left-half (0b010101 = U+258C), right-half (0b101010 = U+2590), and full (0b111111 = U+2588). A lookup table maps each codepoint offset to its bitmask.

### Smooth Mosaic Wedges (U+1FB3C–U+1FB6F)

52 filled polygons using normalized coordinates (0–1) mapped to cell dimensions. Grid points: X ∈ {0, 1/2, 1}, Y ∈ {0, 1/3, 2/3, 1}. All shapes are straight-edged (no curves).

Includes:
- Lower-left/right diagonal families
- Upper-left/right diagonal families
- Three-quarter blocks (3 of 4 center-corner triangles filled)
- One-quarter blocks (single center-corner triangle)

### 1/8th Block Elements (U+1FB70–U+1FB8B)

| Range | Description |
|---|---|
| U+1FB70–U+1FB75 | Vertical 1/8 strips at column positions 2–7 |
| U+1FB76–U+1FB7B | Horizontal 1/8 strips at row positions 2–7 |
| U+1FB7C–U+1FB81 | Combined corner/edge 1/8 blocks + stripe patterns |
| U+1FB82–U+1FB86 | Upper fractional blocks: 2/8, 3/8, 5/8, 6/8, 7/8 |
| U+1FB87–U+1FB8B | Right fractional blocks: 2/8, 3/8, 5/8, 6/8, 7/8 |

Positions 1/8 and 8/8 are not included because they already exist as U+258F (left 1/8), U+2595 (right 1/8), U+2594 (upper 1/8), U+2581 (lower 1/8), U+258C (left half), U+2590 (right half), U+2580 (upper half).

## Implementation

All custom rendering happens in `CanvasTerminal.tsx`'s `paintRow()` function (Pass 2: text). Before the generic `fillText()` fallback, codepoints are checked against each range in order:

1. Box drawing → `drawBoxDrawingChar()`
2. Block elements → `drawBlockChar()`
3. Powerline → `drawPowerlineChar()` (handles own fg/bg)
4. Braille → `drawBrailleChar()`
5. Legacy computing → `drawLegacyComputingChar()`
6. Everything else → `fillText()` with configured font

## References

- [Unicode Symbols for Legacy Computing](https://www.unicode.org/charts/nameslist/n_1FB00.html)
- [WezTerm customglyph.rs](https://github.com/wezterm/wezterm/blob/main/wezterm-gui/src/customglyph.rs)
- [Alacritty built-in font](https://github.com/alacritty/alacritty/tree/master/alacritty/src/renderer/builtin_font)
