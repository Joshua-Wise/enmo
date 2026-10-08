---
name: Temperature Alarms
description: Calm, factual monitoring for network closets; dark by default, numbers first, colour only as a signal.
colors:
  console-black: "oklch(0.145 0 0)"
  panel-grey: "oklch(0.205 0 0)"
  raised-grey: "oklch(0.269 0 0)"
  readout-white: "oklch(0.985 0 0)"
  primary-ink: "oklch(0.922 0 0)"
  dimmed-grey: "oklch(0.708 0 0)"
  hairline: "oklch(1 0 0 / 10%)"
  input-hairline: "oklch(1 0 0 / 15%)"
  focus-grey: "oklch(0.556 0 0)"
  signal-blue: "oklch(0.488 0.243 264.376)"
  humidity-green: "oklch(0.696 0.17 162.48)"
  critical-red: "oklch(0.704 0.191 22.216)"
  critical-fill: "oklch(0.505 0.213 27.518)"
  high-red: "oklch(0.637 0.237 25.331)"
  warning-amber: "oklch(0.769 0.188 70.08)"
  moderate-yellow: "oklch(0.852 0.199 91.936)"
  fault-violet: "oklch(0.606 0.25 292.717)"
  mdf-sky: "oklch(0.685 0.169 237.323)"
  daylight-white: "oklch(1 0 0)"
  daylight-ink: "oklch(0.145 0 0)"
  daylight-muted: "oklch(0.97 0 0)"
  daylight-dimmed: "oklch(0.556 0 0)"
  daylight-hairline: "oklch(0.922 0 0)"
typography:
  display:
    fontFamily: "system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: "3rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  headline:
    fontFamily: "system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-ink}"
    textColor: "{colors.panel-grey}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.console-black}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.raised-grey}"
  button-ghost:
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.raised-grey}"
  button-destructive:
    backgroundColor: "{colors.critical-fill}"
    textColor: "{colors.daylight-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.raised-grey}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.panel-grey}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.xl}"
    padding: "24px"
  tile:
    backgroundColor: "{colors.panel-grey}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.xl}"
    padding: "16px 20px"
  badge-online:
    backgroundColor: "{colors.humidity-green}"
    textColor: "{colors.humidity-green}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-condition:
    backgroundColor: "{colors.warning-amber}"
    textColor: "{colors.warning-amber}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  badge-critical:
    backgroundColor: "{colors.critical-fill}"
    textColor: "{colors.daylight-white}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  nav-item:
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.raised-grey}"
---

# Design System: Temperature Alarms

## 1. Overview

**Creative North Star: "The Night Shift Console"**

A console read on the night shift: dark by default, the readouts first, and every light on the board there because it means something. The surfaces are pure greys at three depths, the type is the operating system's own sans, and the biggest thing on any screen is a number. Nothing decorates. When every closet is comfortable the page is almost monochrome; a Condition is the loudest thing on it, and the worst active Condition sets the tone of its card. This is the visual form of PRODUCT.md's *quiet until it matters* and *calm, factual, trustworthy*.

The system explicitly rejects the SaaS analytics dashboard (gradient accents, hero metrics, decorative charts), the consumer smart-home app (big rounded tiles, playful icons, weather-app styling), the industrial SCADA console (dense monochrome grids, tiny text, blinking indicators), and the old PHP and Bootstrap version of this site. It is a shadcn/ui set used plainly, in Tailwind v4, with the tokens in `frontend/src/index.css` as the single source of colour and radius.

Density is moderate: five pages (Dashboard, Campuses, Incidents, History, Settings) behind an inset sidebar, page sections 24px apart, cards padded 20 to 24px, tables at 14px with tabular figures. A light theme exists with the same structure; dark is what ships by default and what the palette below is written for.

**Key Characteristics:**
- Dark, chroma-zero surfaces at three depths; colour appears only as a signal.
- Numbers are the display type: 48 to 60px, semibold, tabular, tight tracking.
- One sans family (the system stack) at every size; a mono only for Device hostnames.
- Hairline borders and tonal steps carry depth; the page itself casts no shadows.
- Standard shadcn shapes, 8px radius on controls and 14px on cards, no decoration.
- Motion states a change (a fade-in, a spinning refresh icon) and never performs.

## 2. Colors: The Console Palette

Greys carry everything; colour is a signal, and each signal colour has exactly one meaning.

### Primary
- **Primary Ink** (`oklch(0.922 0 0)`): the near-white fill of the one primary button on a screen (Sign in, Save) and text selection. In this system the primary is a grey; there is no brand hue on buttons.
- **Signal Blue** (`oklch(0.488 0.243 264.376)`): the sidebar mark and the temperature line on charts. It is the only blue, and it never fills a button or a badge.

### Neutral
- **Console Black** (`oklch(0.145 0 0)`): the page background and the fill of outline buttons.
- **Panel Grey** (`oklch(0.205 0 0)`): cards, tiles, the sidebar, popovers and dialogs. One step up from the page.
- **Raised Grey** (`oklch(0.269 0 0)`): muted and accent surfaces: hover fills, input backgrounds, the active nav item, table header on hover. Two steps up.
- **Readout White** (`oklch(0.985 0 0)`): all primary text and the big numbers.
- **Dimmed Grey** (`oklch(0.708 0 0)`): secondary text: labels above numbers, table captions, timestamps, the unit after a number. It meets 4.5:1 on Panel Grey; do not go lighter.
- **Hairline** (`oklch(1 0 0 / 10%)`): every border on the page: cards, table rows, the dashed empty-state panel. **Input Hairline** (`oklch(1 0 0 / 15%)`) is the same idea on inputs and outline buttons.
- **Focus Grey** (`oklch(0.556 0 0)`): the ring colour at 50% alpha, 3px, on every focused control.

### Signal colours (Conditions and state)
These are the Tailwind v4 palette values the Condition looks in `frontend/src/lib/conditions.ts` use. Each is a tint (15 to 20% alpha fill, coloured text) except critical, which is solid.
- **Critical Red** (`oklch(0.704 0.191 22.216)`): the `destructive` token, tuned to read on dark grey: error text, error icons, and the border of a critical card. Never a fill under text.
- **Critical Fill** (`oklch(0.505 0.213 27.518)`): the `destructive-solid` token, the only red that goes under white text: the critical Condition badge and the confirm button of a destructive dialog. White on it is 6.4:1; white on Critical Red is 2.9:1, which is why the two exist. In the light theme both are the same red.
- **High Red** (`oklch(0.637 0.237 25.331)`): Mold risk at the high level: tinted badge and a 70% border.
- **Warning Amber** (`oklch(0.769 0.188 70.08)`): Hot, Cold, Dry and Offline at warning, the "Reconnecting" stream status, the warn tone on a tile's note, a missed report (late): the footer note and the report hairline, and a day an incident reached warning (and no worse) on the Campuses chart. Tinted badge and a 70% border.
- **Moderate Yellow** (`oklch(0.852 0.199 91.936)`): Mold risk at the moderate level only. A heads-up the card shows and the summary does not count.
- **Fault Violet** (`oklch(0.606 0.25 292.717)`, Tailwind violet-500; violet-600 on light): Sensor fault on the incident ruler and in its legend, and nowhere else. Sensor fault is always critical, and wherever the level speaks (the badge, the card border, the escalation trace, the Campuses column) it is Critical Fill and Critical Red like any critical Condition; only the ruler, where a hot closet and a closet nobody is watching would otherwise be the same red span, gives it its own hue. It is the one colour bound to a Condition rather than a level, and it is never text.
- **Humidity Green** (`oklch(0.696 0.17 162.48)`): the Online badge, the "Live" stream dot, and the humidity line on charts.
- **MDF Sky** (`oklch(0.685 0.169 237.323)`): the outline tag that marks a Main Distribution Frame. IDF tags stay grey.

### Light theme
The same roles on **Daylight White** (`oklch(1 0 0)`) with **Daylight Ink** (`oklch(0.145 0 0)`) text, **Daylight Muted** (`oklch(0.97 0 0)`) for raised surfaces, **Daylight Dimmed** (`oklch(0.556 0 0)`) for secondary text and **Daylight Hairline** (`oklch(0.922 0 0)`) for borders. Signal colours keep their hue and shift to the 700 and 800 steps for text so they still read on white.

### Named Rules
**The One Meaning Rule.** A signal colour is bound to one Condition level or one state and is never used for emphasis, decoration, or brand. Amber means warning wherever it appears; if it appears anywhere else, it is wrong. A confirmation tick is grey, not green: green means Online.

**The Two Reds Rule.** No mid-luminance red reads both as text on dark grey and as a fill under white. Critical Red is for text and borders, Critical Fill for solid surfaces; swapping them fails AA in the dark theme.

**The Worst Wins Rule.** A card takes the border of its worst active Condition and only that one. Badges list every Condition; the border says which matters most.

**The Grey Button Rule.** Primary actions are near-white on dark, not blue. The only blue on a screen is the sidebar mark and a chart line, so a technician's eye is never pulled to a button when it should be on a number.

## 3. Typography

**Display Font:** system-ui (with Avenir, Helvetica, Arial, sans-serif)
**Body Font:** system-ui (the same stack)
**Label/Mono Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas) for Device hostnames only

**Character:** one family, the operating system's own, from 12px labels to 60px readouts. Weight and tabular figures do the work a second family would; the numbers are the display type and everything else defers to them.

### Hierarchy
- **Display** (semibold 600, 3rem to 3.75rem, line-height 1, tracking -0.025em, tabular figures): the latest temperature on a Device card, sized to be read from across a room. Its unit follows at 1.5 to 1.875rem in Dimmed Grey. The humidity readout is the same treatment at 1.875 to 2.25rem.
- **Headline** (bold 700, 1.875rem, tracking -0.025em): the page title, once per page: Dashboard, Campuses, Incidents, Settings, or the Closet name on History.
- **Title** (semibold 600, 1.125rem, line-height 1.25): the Closet name on a card and card titles. Tile values are semibold 1.875rem, tabular.
- **Body** (regular 400, 0.875rem, line-height 1.5): everything else: table cells, descriptions, dialog copy, notes. Inputs are 1rem on touch widths and 0.875rem from `md` up. Prose is capped by `max-w-sm` in placeholders and reads under 65ch.
- **Label** (medium 500, 0.75rem, sentence case): the word above a readout or tile value, badge text, the note under a tile. Never uppercase, never tracked.
- **Mono** (regular 400, 0.875rem): `ESP_A1B2C3`, and nothing else.

### Named Rules
**The Tabular Rule.** Any number that can change while it is on screen is set `tabular-nums` so it does not jitter when it changes. Ages, countdowns, readouts, table columns, tile values.

**The Sentence Case Rule.** Headings, labels, buttons and badges are sentence case. No uppercase tracked eyebrows anywhere.

## 4. Elevation

Flat and tonal. Depth on the page comes from three grey steps (Console Black, Panel Grey, Raised Grey) and hairline borders at 10% white; nothing on the page itself casts a shadow. Cards carry Tailwind's `shadow-sm` and outline buttons `shadow-xs`, both invisible on dark and a whisper on light, kept only so the shadcn primitives stay stock. Overlays are the exception: dialogs, menus and popovers float on Panel Grey with a real shadow because they sit above the page rather than in it.

### Shadow Vocabulary
- **Resting** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`): cards and outline buttons at rest. Present for consistency, not for depth.
- **Overlay** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): dialogs and dropdown menus, the only things allowed to float.

### Named Rules
**The Three Greys Rule.** Page, panel, raised. If a surface needs a fourth depth, the layout is wrong, not the palette.

**The Nothing Floats Rule.** Shadows appear only on overlays. A hover never lifts a card; it changes a fill (Raised Grey) or a text colour.

## 5. Components

Plain and precise: stock shadcn/ui shapes, 8px radius on controls and 14px on containers, no decoration. The content is the design.

### Buttons
- **Shape:** gently rounded (8px), 36px tall, 14px medium text, 8px gap to a 16px icon. Small is 32px with 12px padding; icon-only is a 36px square. Under a coarse pointer (`pointer-coarse:`) every button, input, select and its options, tab, sidebar item, and the sidebar trigger grows to at least 44px; under a mouse the density above stands.
- **Primary:** Primary Ink fill with Panel Grey text, 8px by 16px padding. Hover drops the fill to 90%. One per view at most.
- **Outline:** Console Black fill, Input Hairline border, Readout White text. Hover fills Raised Grey. The default for every secondary action: Refresh, Try again, Previous and Next day (or night, or 7 days), History on an incident, Cancel.
- **Ghost:** no fill or border; hover fills Raised Grey at 50%. Inline actions in a row of text: Change, Forget, Today.
- **Destructive:** solid Critical Fill with white text; used only as the confirm button inside a destructive dialog. The trigger for a destructive flow is an Outline button with Critical Red text.
- **Focus:** a 3px ring in Focus Grey at full strength (`oklch(0.556 0 0)` in both themes, so it clears 3:1 against every surface) plus the border turning to the ring colour. Under forced colours it is a 2px CanvasText outline, and the selected tab and current page take Highlight. Disabled is 50% opacity with pointer events off.

### Chips (badges)
- **Style:** 8px radius, 12px medium text, 2px by 8px padding, a 12px icon before the word where one helps (Wifi, WifiOff).
- **Condition badge:** tinted fill at 15% (20% on dark) with the level's colour as text; the name in semibold and the level after a middle dot at normal weight and 90% opacity (full strength on the light theme's critical badge, for contrast). Padded up to 4px by 10px and 14px text so it reads at a distance. Critical is solid Critical Fill with white text.
- **Online badge:** Humidity Green tint with green text and the Wifi icon. Offline uses the warning look with WifiOff.
- **Tag:** outline variant in Readout White for IDF; MDF Sky border and tint for MDF.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Panel Grey with Readout White text.
- **Shadow Strategy:** resting shadow only; see Elevation.
- **Border:** Hairline at rest; a Condition card swaps it for the worst level's colour at 70%, or solid Critical Red.
- **Internal Padding:** 24px vertical and horizontal on a standard card; a Device card and a tile use 20px horizontal with 20px and 16px vertical.
- **Device card (signature):** Campus name in Dimmed Grey above the Closet name in Title, the tag beside it and the Online badge on the right; the temperature Display and humidity readout side by side; a row of Condition badges; under them, who is on each open incident ("Acknowledged by Sam, 10 min ago", a 16px UserCheck icon and the line in Dimmed Grey with the name in Readout White medium, no signal colour, since being on it is not a level), or, for an Admin, a ghost "Acknowledge" that opens a small field for a name or short note with an outline Acknowledge and a ghost Cancel; for a board on its fallback network, "On its fallback WiFi network" as a line in the same grey with a 16px Wifi icon (a note, not a Condition: no signal colour, no badge, no border); a footer with the age of the last report (a Reading, or a fault report from a board whose sensor is not answering), the countdown to the next, and an outline History button. The border is the worst Condition.
- **Tile:** a `dl` entry: 14px Dimmed Grey label, 1.875rem semibold tabular value, a 12px note beneath that turns Warning Amber when it carries a warning.
- **Sign-in page:** every page needs someone signed in. Without a session the page is a card on Console Black, centred, no sidebar: the district mark above it, "Sign in" as the h1, Username and Password fields, one full-width primary "Sign in", and a refusal under the fields as an inline error (role alert) saying only what the server said ("Wrong username or password", or too many tries). It returns to the page that was asked for. `admin` signing in on a fresh install's own password gets the same card titled "Choose a new password" (current, new, again) and nothing else until it is saved.
- **User menu:** the sidebar's foot: a 32px Raised Grey square with a UserRound icon, the username in medium 14px and the role (Admin or Viewer) in 12px Dimmed Grey beneath, a menu with Change password (a dialog with the same three fields) and Sign out. A Viewer sees every page; Settings shows them the Campus and Device lists with no control that changes anything, and no other tab.
- **Skip link:** the first focusable thing on every page, "Skip to content", hidden until focused, then shown top left on a Panel surface with the focus ring.
- **Page not found:** an unknown route renders the Placeholder pattern with a link back to the Dashboard, under its own document title.
- **Placeholder:** the empty and error state for a region: a dashed Hairline border, 14px radius, 64px vertical padding, centred: a medium heading, a Dimmed Grey sentence under 65ch, and one outline action.
- **Incident log (Incidents):** one card, oldest first, with a one-paragraph summary above it in 1.125rem (the count, the worst incident with its peak, and what is still going, all as the API returned them). Each row reads as a sentence with its numbers: the start in Title weight with "to 7:05 PM" or "ongoing" in Dimmed Grey beneath; the Condition badge with its level and the duration beside it ("1 h 20 min so far" in Readout White medium while it goes on: ongoing is not a level, so it takes no signal colour); the Campus in Title weight with "· Closet" in Dimmed Grey; the peak facts in Dimmed Grey with the figures in Readout White; who acknowledged it, as on the card but with the time ("Acknowledged by Sam at 2:10 AM"), or the ghost Acknowledge while it is open; the hostname in mono; and an outline "History, Oct 4" button to that Device's day. Beside it at 1024px and up (under it below) sits the row's span on the shared ruler (see Charts). Empty is the Placeholder ("No incidents overnight") with a Previous action.
- **Campus overview (Campuses):** for IT leadership, the district in one look. A one-sentence summary in 1.125rem replaces headline tiles: how many Campuses have a closet in a Condition now and which, how many are in range, and any Mold risk heads-up, with the scope beneath in 14px Dimmed Grey (Campuses, closets, the seven days, "as of" the load). Then one card holding a table, one row per Campus in the server's worst-first order: the Campus name in Title weight as a link to the Dashboard filtered to it, its shortcode and closet count beneath; "In a Condition now" as Condition badges each with "2 closets" in Dimmed Grey, moderate Mold risk after them as "1 closet, heads-up", or "None"; the worst closet's temperature at 1.875rem semibold with the unit in Dimmed Grey, its Closet name in medium and humidity beneath, the whole a link to its History today (an Offline closet shows a dash and "Offline, last Reading 41 min ago"); the 7-day column chart (see Charts) with the week's peak beside it at 1280px and up; and "Since last incident" as a Title-weight figure ("3 days", "Ongoing", "None in 90 days") over "Ended Thu, Oct 1, 4:42 PM", linking to the Incidents page on that day. Ongoing takes no signal colour, as in the incident log. Links read as text, underline on hover, and take the 3px focus ring. A footnote in 14px Dimmed Grey names the threshold the line draws and the retention window "since last incident" looks back over. Under 768px the header row goes and each row becomes its own card, the name on top and each cell a labelled line (a 7.5rem Dimmed Grey label, the value beside it). Empty is the Placeholder ("No Campuses yet") with an Open Settings action.

### Inputs / Fields
- **Style:** 36px tall, 8px radius, Raised Grey fill at 30% on dark (transparent on light), Input Hairline border, 12px horizontal padding, placeholder in Dimmed Grey.
- **Focus:** the same 3px Focus Grey ring as buttons.
- **Error / Disabled:** `aria-invalid` turns the border Critical Red with a red ring at 20 to 40%; disabled is 50% opacity with a not-allowed cursor.
- **Native date field:** styled to match the input (same height, border, radius, tabular text) so day navigation reads as one control group with its Previous and Next buttons.
- **Window label (Incidents):** the same box as the date field, with a calendar icon and the window in words ("Sat, Oct 3 to Sun, Oct 4"), between Previous and Next. It is text, not a field: the window tabs (Overnight, Today, 7 days) pick the length, the arrows step it, and Next is disabled at the latest window, so it never runs past the present. On a phone it stretches between the two arrows.

### Navigation
- **Style:** an inset sidebar on Panel Grey, collapsible to icons; the district mark is a 32px Signal Blue rounded square with a white icon, the district name in medium 14px and the product name in 12px beneath.
- **Items:** 32px tall, 8px radius, a 16px Lucide icon and a 14px label; hover fills Raised Grey at 50%, the active route fills Raised Grey. Router links, so navigation never reloads. The order is Dashboard, Campuses, Incidents, Settings: the technicians' page, the leadership overview, the log, then the admin hat.
- **Mobile:** the sidebar becomes a sheet behind the trigger in the 64px header; pages stack to one column and the Device grid collapses with `auto-fill, minmax(min(19rem, 100%), 1fr)` (the `min()` keeps a card inside a 320px viewport) (19rem so a typical Closet name and Campus fit beside the Online badge at 1440px with the sidebar open; truncation is only the fallback for a very long name). The dashboard's four tiles sit two by two under 640px, so the first card starts on the first screen. The Campus tabs stay tabs on a phone: one strip that scrolls sideways and runs to the screen's edges, with 52px targets on a touch screen. The order control sits beside them on the right, and wraps under them when the row is too narrow.

### Charts
- Recharts inside the shadcn ChartContainer. Temperature in Signal Blue and humidity in Humidity Green, dashed, on two axes; grid lines are Hairline at 50%; ticks are 12px Dimmed Grey; the day runs midnight to midnight. No dots above 48 points, no fill areas, no animation on live reloads.
- The lines are drawn from per-bucket means (`lib/chartBuckets.ts`), never from every Reading: the DHT11 reports whole degrees and whole percent, so raw Readings flicker by one step and a full day of them draws a solid block, with the dashed humidity line broken into hatching. The bucket is chosen from the span the Readings cover (1, 2, 5, 10, 15, 30 or 60 minutes, about 288 points at most, so 5 minutes for a full day), and the tooltip names the bucket and how many Readings it averages. The day's raw low and high of each series are marked where they happened, with their value, as small dots in the series' colour, so a mean never hides a spike that crossed a threshold. The tiles and the Readings table stay on the raw Readings.
- **The incident span chart (Incidents):** the log's second reading. Every incident row carries a span on one ruler the whole window shares (18:00 to 08:00 for Overnight, midnight to midnight for Today, seven days for 7 days), so overlaps and the worst stretch of the night show without reading. The span is 14px tall, 6px radius, and segmented by the levels the server recorded, each in its signal colour as a fill with no text on it, by the One Meaning Rule: Warning Amber at 45%, High Red at 55%, Moderate Yellow at 35% (70%, 70% and 60% in the light theme, so a span still reads on white), and Critical Fill solid for critical (the Two Reds Rule: the fill red, never the text red). A Sensor fault span is Fault Violet, solid (violet-600 on light), not Critical Fill, so a dead sensor is not read as a closet that ran hot. A legend in the log card's top right (top left on a phone), 12px Dimmed Grey with a 16 by 10px swatch per entry, names each colour the window's spans are drawn in (Critical, High, Warning, Moderate, then Sensor fault), only those present (`rulerKinds`). An ongoing span runs to now and ends square with a 2px Readout White cap; a span cut by the window's edge is square on that side. "Now" is a dashed Focus Grey line through every row, labelled in Readout White on the ruler. Grid lines are Hairline at 50%, every 2 hours of a night, 3 of a day, and at each midnight of a week (the day names sit at noon); ruler labels are 12px Dimmed Grey, tabular. Under 1024px the span moves under its row and the ruler keeps only its major marks (every 6 hours, or each day). The chart is `aria-hidden`: the row's text says everything the span shows. Spans are placed in the browser from the server's start, end and segments (`lib/incidentWindow.ts`); no level is judged there.
- **The 7-day column chart (Campuses):** a small labelled column chart in each Campus row, an inline SVG rather than Recharts. Seven columns, 18px wide, 8px apart, on a 44px plot, oldest first: each is that day's highest Reading at the Campus, with the day's narrow initial beneath in 12px Dimmed Grey. Across them runs the server's Hot warning line, 1px dashed Dimmed Grey, wider than the columns by 4px each side. Columns are Dimmed Grey at 45%, and today, still going, at full Dimmed Grey; a column takes the signal colour of the worst level an incident reached that day (`incidentLevel`, from the server's segments; the `column` look in `lib/conditions.ts`: Warning Amber or High Red at 70%, Critical Fill for critical, today solid; the 600 step on light) only on a day the server flagged, by the One Meaning Rule, never because the high crossed the line, and never amber for a day that went critical. A day with no Readings draws a 1px Hairline stub, not a zero. The scale runs from 8°F under the lowest of the highs or the line to 2°F over the highest, per row, so the chart compares days within a Campus, not Campuses; the figures carry the comparison across rows. The SVG is `role="img"` with every day's high, the line, and the incident days in its label (`lib/campusOverview.ts`). No axis, no grid, no tooltip, no animation.


### Motion
Motion states a change and never performs. The vocabulary lives in `frontend/src/lib/motion.ts` and the easing tokens in `index.css`: a change settles out on an exponential ease (`--ease-out-quint`, 200ms), an exit is quicker (120 to 150ms), a deliberate move uses `--ease-out-expo`, and nothing bounces, loops, or blinks. Only transform, opacity, colour, clip-path and SVG stroke are animated; no width, height, top, or left.
- **A Condition escalating (the focal moment):** when a card's worst Condition rises (none, moderate, warning, high, critical), the new border is drawn around the card once (`EscalationTrace.tsx`): a 2px stroke in the level's colour grows both ways from the point on the edge nearest the badge that caused it (the Condition badge on the left edge, the Offline badge at the top right), meets on the far side after 620ms on the expo ease, then fades over 360ms into the card's own 1px border, which takes the colour as the stroke closes. The new badge arrives with it, wiped in from the same side (`reveal`); the badge it replaces (the same Condition at its old level) goes at once, so the old level is never shown beside the new border. This is the Worst Wins Rule made literal. A fall is quiet: the border crossfades back over 300ms and nothing is drawn.
- **A Reading landing:** the card's fill rises to Raised Grey and settles back over 800ms (`animate-reading-landed`) while NumberFlow rolls the readout in the direction of the change (400ms expo), clipped to its own line so a rolling digit never crosses the label above. Grey, not a signal colour: it says which closet just spoke, not how it is.
- **Late, then Offline, as one progression:** the footer's top hairline carries the Report interval (`ReportHairline.tsx`). While a Device is on time a faint line over it (Dimmed Grey at 20%, so sixty healthy cards stay quiet) empties across the interval (one CSS transform per card, started per Reading with a negative delay, removed while the tab is hidden); a missed report stops it and turns the hairline Warning Amber beside "Expected Ns ago"; Offline turns it dashed. The countdown and age are plain tabular text that changes in place, never a rolling counter.
- **Card to History and back:** the Closet name with its IDF/MDF tag, the Campus and the temperature travel from the card into History's header and back again on its back button (`lib/card-morph.ts`, the View Transitions API, 440ms expo). The old page fades out over 140ms and the new one fades in over 180ms from 50ms, so the header assembles over a page already arriving (a later start leaves blank frames between the two). Each part swaps its two images early (out in 100ms, in by 160ms), the readouts are as wide as their figures, and the unit is half the figure at both ends, so a name or a number is never seen twice. History renders its header at once from what the card knew, so the move always has somewhere to land. The browser's own back button and every other route change use the route fade.
- **The order:** a second set of tabs beside the Campus tabs (under them on a phone, where the Campus strip runs to the screen's edges), "Worst first" (the default) and "By Campus", kept in the URL like the Campus filter (`?order=campus`; worst first is the absent default). The server sorts, worst level first (critical, high, warning with Offline among it, moderate, then none), ties by Campus name and closet; the browser never re-sorts. Under worst first, a live Reading that changes a card's worst level asks the server again, and the card glides to its new place with the Campus filter's FLIP, so a closet turning Hot critical visibly rises; a new Reading at the same level moves nothing.
- **The Campus filter:** the active tab's fill slides to the new Campus (a shared layout move); the cards on screen stay until the new Campus's arrive, then a card that stays glides to its new place (FLIP, 320ms expo) only when it is on screen both before and after (the same move carries an order change); any other card that stays fades in where it lands (200ms), cards that leave fade in 120ms, and cards that join fade in (`Regroup.tsx`). Cards measure their places only when the set or order changes, never on the once-a-second tick.
- **A History day change:** the header and day picker stay still; the day's tiles, chart and table slide 32px in the direction of travel and crossfade (280ms in, 140ms out). The temperature line draws left to right once (700ms) when a day first loads, never on a live reload.
- **State in place crossfades:** the Online badge, the "Next in" and "Expected ago" notes, Condition badges leaving (a Condition that has cleared, not one that worsened), and the Live dot's colour.
- **Arrival:** a page's content fades in from a skeleton of the same shape over 200ms (the Campus tabs and History's header have placeholders too, so nothing jumps); on a first visit Device cards arrive with a 6px rise, 30ms apart, capped at the eighth. A return to the dashboard shows the last cards at once and refreshes them. Settings rows fade in when added and out when deleted.
- **An incident arriving (Incidents):** a new incident on the stream joins the end of the log, like the next line of a log, with a 6px rise and the Reading-landed wash; a level change keeps its row where it is, takes the wash, and crossfades its badge. A closed incident changes in place with no wash. Reduced motion keeps the fade and the wash's opacity and drops the rise.
- **A Campus row changing (Campuses):** the page reloads the overview on the stream's Reading and incident messages, at most once every 10 seconds (the first message after a quiet spell at once, a burst after it in one request at the end of the 10 seconds). A row whose numbers changed takes the Reading-landed wash over the whole row; rows keep the server's order and nothing glides.
- **Routes:** a 220ms fade with an 8px rise in, and no exit, so a click is answered on the next frame. A new page starts at its top.
- **Sidebar:** collapse and expand move the page panel as one 300ms transform over the sidebar's labels (FLIP), so the page reflows once, not every frame; the phone sheet slides in over 300ms and out over 200ms.
- **Feedback:** every button and tab answers within 100ms (colour, and `active:scale-[0.98]` on buttons); `animate-spin` on the Refresh icon while a reload is in flight; `animate-pulse` on the Reconnecting dot.
- **Reduced motion:** nothing moves, and every change is still visible as a fade. The escalation trace and the card-to-History move are not started; borders, badges and notes crossfade; the depleting line is hidden while the amber and dashed hairline stay; the day change crossfades in place; the sidebar and filter change at once; a card that changes place under a new order fades in where it lands. In CSS a `prefers-reduced-motion` block collapses animation durations (except opacity-only ones marked `data-reduced="fade"`) and keeps only colour and opacity transitions; framer-motion runs under `MotionConfig reducedMotion="user"`; NumberFlow sets the new number without rolling.
- **Higher contrast:** under `prefers-contrast: more`, muted text rises to `oklch(0.82 0 0)` on dark and `oklch(0.42 0 0)` on light, and hairlines strengthen. Under forced colours, incident spans draw in the text colour so their extent survives.

## 6. Do's and Don'ts

### Do:
- **Do** set every changing number in `tabular-nums` and size the latest temperature at 48 to 60px semibold; the number is the design.
- **Do** keep colour to its one meaning: Warning Amber for warning, High Red for high, Critical Fill under white for critical, Moderate Yellow for moderate, Humidity Green for Online and Live, Signal Blue for the mark and the temperature line.
- **Do** give a card the border of its worst active Condition and list every Condition as a badge with its level spelled out; a colour is never the only signal.
- **Do** use the Placeholder pattern (dashed Hairline, 64px padding, one outline action) for every empty and error state, and a Skeleton for loading; never a spinner in the middle of content.
- **Do** use outline buttons for secondary actions, ghost buttons for inline ones, one primary per view, and put every destructive action behind an AlertDialog whose confirm is the only destructive-filled button.
- **Do** keep text at 14px or larger in tables and body, Dimmed Grey no lighter than `oklch(0.708 0 0)` on Panel Grey, and a visible 3px focus ring on every control.
- **Do** write labels, buttons and badges in sentence case, in the vocabulary of CONTEXT.md (Device, Reading, Campus, Closet, Condition).
- **Do** size every control to 44px under `pointer-coarse:` and leave the mouse density alone; the finger is the case, not the viewport width.
- **Do** give every page one h1 and a document title of its own ("Settings · Temperature Alarms"), and keep the sidebar links inside the `nav` landmark.

### Don't:
- **Don't** build a SaaS analytics dashboard: no gradient accents, no hero-metric tiles with sparklines, no decorative charts, no marketing polish on an internal tool.
- **Don't** build a consumer smart-home app: no big rounded tiles, no playful icons, no weather-app styling.
- **Don't** build an industrial SCADA console: no dense monochrome grids, no text under 12px, no blinking indicators. A pulsing red border was removed from `index.css` for this reason and must not come back.
- **Don't** reproduce the old PHP and Bootstrap version: no default Bootstrap look, no generic admin template, no Font Awesome.
- **Don't** put a coloured `border-left` or `border-right` stripe on anything; a Condition is a full border, a tint, or a badge.
- **Don't** use Signal Blue on a button, a badge, or a link; it belongs to the mark and the chart.
- **Don't** lift a card on hover or add a shadow to anything that is not an overlay.
- **Don't** compute a Condition, a threshold, or a colour rule in the browser; render what the API sends.
- **Don't** add uppercase tracked eyebrows, numbered section markers, gradient text, or glass effects anywhere.
- **Don't** animate layout properties, orchestrate page-load sequences, or ship any animation without a reduced-motion alternative.
