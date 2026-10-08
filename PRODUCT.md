# Product

## Register

product

## Platform

web

## Users

Network technicians at a school district, at a laptop. They open the site deliberately when checking on the closets they look after, and go to a Device's history when something looks wrong. The same people add Devices and Campuses now and then, signed in as an Admin; that is another hat, not a second audience. Everyone signs in, wall screens included; a Viewer can look but not change anything. A dashboard left on a wall screen is a secondary case, not the one the design is built around.

IT leadership at Celina ISD is the second audience (decided 2026-10-05). They want the district's state in one look, weekly or before a meeting: which Campuses need attention, how the week went, and how long each has gone without an incident. They read; they do not add Devices or run History day by day. The technicians also gain a morning job: reading what happened overnight, incident by incident. The comps that set this direction are `.scratch/design/comps/campuses.html` (Campus overview) and `incidents.html` (Incident timeline); the wall screen and facilities views were not chosen.

## Product Purpose

Live temperature and humidity monitoring for network closets across the district's campuses. Each closet has a NodeMCU board with a DHT11 sensor that posts a Reading every Report interval; the backend computes the Conditions a closet is in (Hot, Cold, Dry, Mold risk, Offline) and pushes every Reading to open browsers. Success is a technician learning that a closet is heading for trouble early enough to act, and trusting the numbers and the timeline enough to act on them without checking by hand.

## Positioning

You know a closet is in trouble before the equipment does.

## Brand Personality

Calm, factual, trustworthy. The interface is quiet by default and only raises its voice when a closet is actually in a Condition. Numbers are shown plainly, in the district's own vocabulary (Device, Reading, Campus, Closet, Condition), and never dressed up. Nothing on screen is decided in the browser that the server could decide once for everyone.

## Anti-references

- A SaaS analytics dashboard: gradient accents, hero metrics, decorative charts, marketing polish on an internal tool.
- A consumer smart-home app: big rounded tiles, playful icons, weather-app styling.
- An industrial SCADA console: dense monochrome grids, tiny text, blinking indicators.
- The old PHP and Bootstrap version of this site: the default Bootstrap look, a generic admin template.

## Design Principles

- Quiet until it matters. A comfortable closet takes up as little attention as possible; a Condition is the loudest thing on the page, and the worst one sets the tone.
- The server decides, the browser shows. Every Condition, its level, and every threshold come only from the API, so all pages, and any future alerting, agree. The dashboard's summary tiles may total what the API returned (counts and averages over the Devices on screen), but never decide a Condition themselves.
- Say what happened, with the numbers. The value, when it was recorded, and how long ago; history by the day with lows, highs, and averages beside the chart.
- The same vocabulary everywhere. Labels and copy use the words in CONTEXT.md, so a technician reads the site the way the team talks.
- Earned familiarity. Standard controls and layouts from the existing shadcn set, used consistently across the three pages, so the tool disappears into the task.

## Accessibility & Inclusion

WCAG 2.2 AA is the bar: contrast, focus visibility, keyboard operation, and a reduced-motion alternative for every animation.
