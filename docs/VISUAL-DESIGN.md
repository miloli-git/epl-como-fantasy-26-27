---
name: Como 26/27 - Daylight Hybrid
status: decided
extracted: 2026-07-08
role: canonical-system
colors:
  ground: "#F4F5F1"        # warm chalk - page ground and board cell-gap colour
  card: "#FFFFFF"          # cells and cards
  ink: "#1C2420"           # primary text
  muted: "#6B7268"         # labels, secondary text
  hair: "#E3E6DF"          # internal hairlines
  gap: "#DFE3DC"           # board cell-grid gaps (1px)
  bronze: "#8F6B24"        # punctuation only - eyebrow dot, sealed value
  value-good: "#1B7A45"
  value-bad: "#B3402E"
  value-fair: "#8A6D1C"
  value-good-tint: "rgba(16,185,120,0.13)"
  value-bad-tint: "rgba(223,74,50,0.12)"
  value-fair-tint: "rgba(217,154,27,0.14)"
console-colors:
  ground: "#141715"
  card: "#232725"
  ink: "#DDD9CE"
  muted: "#96938A"
  hair: "#2B2F2D"
  brass: "#C9A44C"         # replaces bronze in the console skin
typography:
  display:
    fontFamily: "Hanken Grotesk"
    fontWeight: 300
    letterSpacing: "-0.03em"
  label:
    fontFamily: "Hanken Grotesk"
    fontWeight: 700
    fontSize: "11-15px"
    letterSpacing: "0.09em"
    textTransform: "uppercase"
  body:
    fontFamily: "Inter"
    fontWeight: 400-600
rounded:
  card: "10px"
  pill: "999px"
---

# Visual design system

> **Status: decided.** This is the final visual direction for Como 26/27,
> nicknamed "the Daylight hybrid." It supersedes any earlier direction this
> file previously described. Product design (surfaces, flows, max-bid logic)
> lives in `docs/DESIGN.md`; this file covers colors, type, and surfaces only.

## Overview

The system has three layers stacked on top of each other:

1. **Daylight** - a warm, light, editorial base: warm-chalk ground, light
   (never bold) display type, white cards with no borders, tinted pills for
   status. This is the formatting language for every screen.
2. **Club-colour wash** - each Premier League club's own colours identify
   "whose lot this is" across the board, without ever touching money or
   status colour.
3. **Player photography** - the player up for auction is a real, large
   portrait, not an icon or a row in a table.

On top of all three, the auctioneer's console screen gets a **dark token
override** so their display is not a floodlight in an otherwise dim room on
draft night. Everything else - the boards, the reveal, the squads and
ledger views - stays light.

## A. The light system (Daylight)

All room-facing surfaces - board, reveal, squads, ledger - use this palette:

```css
--ground: #F4F5F1;  /* warm chalk - page ground and board cell-gap colour */
--card:   #FFFFFF;  /* cells and cards */
--ink:    #1C2420;  /* primary text */
--muted:  #6B7268;  /* labels, secondary text */
--hair:   #E3E6DF;  /* internal hairlines */
--gap:    #DFE3DC;  /* board cell-grid gaps (1px) */
--bronze: #8F6B24;  /* punctuation only: eyebrow dot, sealed value */

/* value semantics (text) */
--value-good: #1B7A45;
--value-bad:  #B3402E;
--value-fair: #8A6D1C;

/* value pills: 12-14% tints of the same three colours */
--value-good-tint: rgba(16, 185, 120, 0.13);
--value-bad-tint:  rgba(223, 74, 50, 0.12);
--value-fair-tint: rgba(217, 154, 27, 0.14);
```

### Typography

- **Display and numerals:** Hanken Grotesk **300** (light), never bold above
  20px, with -0.03em letter-spacing. This is the single defining move of the
  system - big headings and big numbers are always light-weight.
- **Body and UI:** Inter, 400/500/600.
- **Labels and eyebrows:** Hanken Grotesk **700**, 11-15px, UPPERCASE, with
  +0.09em letter-spacing.
- **All money and points values** use `font-variant-numeric: tabular-nums`,
  everywhere they appear.
- Fonts are self-hosted (via `next/font`), not loaded from Google Fonts, so
  the app has no external font dependency on draft night.

### Surfaces

- **No borders on cards, no left accent bars, no neumorphism.** Elevation
  comes from layered blue-grey shadows (`rgba(50, 50, 93, ...)`), never flat
  black shadows and never card outlines. Hairlines only ever appear *inside*
  a surface (a table rule, a divider) - never around one.
- **Buttons are pills.** Primary = solid ink fill with white text. Quiet =
  white fill with a small shadow. Ghost = transparent with muted text.
- **Semantic colour (green/red/amber) touches values only** - prices,
  deltas, live status, verdicts. Tiers and structure stay neutral (plain
  grey chips); colour is never used to distinguish structural categories.
  Bronze punctuation appears at most a few times per screen - it marks a
  sealed value or an eyebrow label, never a fill or a background.

### The board canvas

The auction board (and the other TV-facing screens) render as a **fixed
1600x900 canvas**, laid out as a grid of cells on a 1px `--gap` grid line,
then scaled down to fit the viewport by `clientWidth / 1600`. This keeps the
layout pixel-perfect at any screen size instead of trying to make a dense
data-dense grid responsive.

There is one known bug class worth calling out for anyone touching this
code: if the board's container measures a width of zero - for example the
tab loaded while backgrounded - a naive scale calculation produces
`scale(0)` and the board renders blank. The fix is to guard the scale
calculation: while measured width is zero, leave scale unset and retry on
the next animation frame, and re-measure on resize, page load, and
`visibilitychange`. This exact bug surfaced during mockup review; the
scaling logic must keep the guard.

## B. The club-colour wash (identity layer)

Every club has three authored colour tokens - a shirt colour, a trim
colour, and a text colour chosen to sit on the shirt colour - sourced from a
verified club-colours table covering all 20 Premier League clubs. Everything
else club-coloured is derived from those three in code: a band gradient from
the shirt colour into a darkened version of itself, a darkened photo
background, and a light 12%-tint chip for use on light surfaces.

The wash is deliberately limited to seven surfaces: the club band on the
board, the player-photo background, the points-banner fill on the TV
screens, the nameplate trim, the band text colour, the club dot in the
ledger, and an eligibility highlight in the manager strip. (A couple of
clubs whose shirt colour is very light use dark text instead of the usual
light text - the token table handles this per club.)

The rule that keeps this from getting muddy: **club colour means identity,
semantic colour means money, and the two never share a surface.** If a
club's colours ever clash with the semantic palette, that gets fixed by
adjusting the club's token, never by special-casing the code.

## C. Player photography (identity layer, part two)

The player currently up for auction gets a real portrait, not an icon:

- A large portrait fills the board's featured column: club band (crest and
  club name) at the top, then a bio strip (age, nation, height, squad
  number) on the darkened club-colour background, then the player photo
  itself anchored to the bottom of that gradient, then a dark nameplate
  with the player's name set large in the light display face.
- Smaller face-thumbnail crops of the same photos appear anywhere a player
  needs to be identified compactly: the recently-sold rail, the ledger's
  player column, and the console's current-lot and up-next queue.
- Club crests appear at two sizes: a small gallery/console size and a
  larger size for the board's club band.
- All player photos and club crests are cached locally ahead of draft day,
  so the app has no dependency on an external image CDN or venue wifi on
  the night. A player with no cached photo falls back to a neutral
  silhouette placeholder - never a broken image.

## D. The console skin (operator only)

The commissioner's console screen reuses every component from the light
system, with one dark token override applied as a single scope - it is a
skin swap, not a second design:

```css
/* ground #141715 - card #232725 - hair #2B2F2D */
/* text #DDD9CE - muted #96938A - punctuation "brass" #C9A44C (replaces bronze) */
/* primary button: brass fill, dark text (the hammer) */
```

Rationale: the auctioneer sits in the same dim room as the TV the group is
watching, so their own screen should not be bright enough to wash out the
room. Every other, room-facing surface (the board, reveal, squads, ledger)
stays on the light palette.

## E. Open item

**Whether the TV boards themselves run light or dark on draft night** is
intentionally left open, to be decided at a dress-rehearsal session on the
actual venue TV rather than guessed in code ahead of time. All board
styling is built through the token layer specifically so this can be a
one-set colour swap whichever way it goes, with no restructuring needed.

## Do's and don'ts

- Do keep display type and numerals light (300) at every size above 20px.
- Do use blue-grey layered shadows for elevation; never flat black shadows,
  never card borders.
- Don't use left accent bars, card outlines, or neumorphic inset/extruded
  effects - all three are explicitly rejected.
- Don't let bronze/brass punctuation become a fill, a background, or appear
  more than a handful of times per screen.
- Don't put semantic (value) colour on anything except values, deltas, and
  status - tiers and structure stay neutral.
- Do use tabular numerals everywhere money or points appear.
- Do keep club colour and semantic colour off the same surface.
