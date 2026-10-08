# WEBRING

The underground indie web, as a trading terminal. A hand-coded homepage on a
free host, not a product dashboard. If it looks like it could have been a
default stylesheet in 1998 with someone's taste applied on top, it is right.

## Principles

- **Paper and ink.** One warm off-white sheet (`#f1ead9`) with a faint
  24px graph-paper grid. Surfaces barely step; depth comes from a hard
  3px offset shadow in solid ink, never a blur.
- **Hairlines are real lines.** 1px solid `#15120c`. Dotted for row
  dividers, dashed for ghost buttons, dotted magenta for focus.
- **Square everything.** Radius is 0 on panels, controls, badges, status
  pips, the wordmark dot.
- **Default-browser type.** Body prose is Times. Anything that must line
  up (numbers, tables, inputs) is Courier Prime. Controls and headers are
  Courier Prime, bold, uppercase. The wordmark is Silkscreen, a bitmap face.
  Labels are lowercase italic Times, like a caption under a scanned figure.
- **Link blue is the brand.** `#0000ee` for the accent, nav links, info,
  projection lines. Visited purple `#551a8b` for provenance and drawdown.
  Hover goes `#ff0040`. Nothing glows.
- **Up and down stay semantic.** Green `#0b7a2a`, red `#c4161c`, each with
  a pale wash background. Projections never use them.
- **Interaction is mechanical.** Buttons sit on a 2px hard shadow and
  physically drop into it on press. The active nav item inverts to ink
  and gains a `> ` prompt. The wordmark dot blinks like a cursor
  (disabled under `prefers-reduced-motion`).
- **Nothing floats.** No glass, no gradients, no rounded pills, no
  translucent cards, no soft drop shadows.

## Tokens

See `tokens.json`. Only contract tokens from `src/ui/themes/README.md`
are set; the theme file `src/ui/themes/webring.css` also styles the
structural hooks (`.panel`, `.btn`, `.dt`, `.app-nav-link`, …).
