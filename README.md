# Hotel Management Game

A browser hotel simulation: build and furnish rooms, manage staff and prices, and keep guests happy as the hotel grows.

[Play the game](https://daeyi.github.io/Hotel-Management-Game/).

## Development

Use Node.js 22.12+ (22.x), 24.x, or 26+. The deployment workflow uses Node 22.

```sh
npm ci
npm run dev
```

```sh
npm run build       # Type-check and build the production site
npm test            # Unit, interface, movement, and long-term balance tests
npm run simulate -- 400 24 balanced
```

The full suite includes a 24-seed, 400-day staffing comparison and takes several minutes. A focused run accepts test paths, for example `npm test -- test/controller.test.ts test/events.test.ts`.

## Saves

Progress is stored in this browser. Building and management actions save immediately, even while paused. Simulation ticks and hiding or leaving the page also save. Reloading restores the current part of the hour, pause state, and speed. A warning appears if browser storage fails; keep the page open and retry. Starting a new game explicitly discards the old save.

## Current development

Event visitors complete the guest-personality phase: during calendar events, about one in twenty existing bookings attends the event, stays through its last night, and goes out in the evening. Long stays make up a larger share of occupied rooms. This changes the mix of visitors without adding to calendar demand.

Housekeepers and maintenance workers now have persistent names, experience, work styles, individual wages, and attendance records. Choose from three candidates per role, inspect a worker in the team list or on the floor, and choose who leaves. Experience grows from actual cleaning and repairs; promotions increase speed and wages. Work style trades speed for thoroughness, and unreliable employees can arrive late or miss a day unpaid. Older saves keep their existing staff and positions.

Front desk clerks now join the named roster. Hire for early (06:00–14:00), late (14:00–22:00), or night (22:00–06:00) shifts; a new hotel starts with one clerk on each. Each desk seats two clerks at a time. Coverage gaps, late arrivals and absences affect the real queue. Rookie, skilled and veteran check-ins take 25, 20 and 16 minutes; actual check-ins and complaints build experience. Night contracts pay 25% more, with earned shift wages split across midnight and retained after dismissal. Off-duty shift changes allow rest before another shift.

Save version 22 replaces each old 24-hour front desk position with three named shifts, retaining its total wage budget and existing coverage. Names, shifts, candidates, attendance, pay and partial movement plans survive reloads.

Next: staff specialties, hospitality, fatigue and breaks, cross-training, then morale and quitting. The detailed roadmap is in [guest and staff personalities](docs/designs/guest-staff-personalities.md). Larger rooms and 3D are later milestones described in [rethinking rooms](docs/designs/rooms-rethink.md).

The simulation is in `src/simulation`, player actions and the clock in `src/game`, the Preact interface in `src/ui`, and Phaser drawing in `src/render`.
