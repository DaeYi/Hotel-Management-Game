# Design: Cleaning Overlay

Date: 2026-10-11
Status: SHIPPED
Repo: DaeYi/Hotel-Management-Game
Follows: aligned-movement.md (the overlay reads the same staff plan), housekeeping-balance.md

## Request

> Can we do an overlay on the rooms to indicate that they are dirty or are currently being cleaned? The overlay can be optional, maybe when the cleaning button/tab is pushed/open?

## What it shows

While the Cleaning (housekeeping) panel is open, the floor plan marks every room on the floor being viewed:

| On the map | Meaning |
|---|---|
| Teal tint and frame | A housekeeper is in the room cleaning it (turnover or daily clean) |
| Teal corner brackets | A housekeeper is on the way to it this hour |
| Brown hatching | Dirty between guests, nobody on it this hour |
| Red hatching and frame | Dirty, and housekeepers can't get to it (fix its door or the hallway) |
| Amber dot | A guest's room with a daily clean due, not yet started |
| Brown tint | A room in use or ready to sell under 50% clean: it costs review points |
| Teal bar along the bottom | How far the clean has got |

The key is in the legend under the floor plan while the overlay is on. The panel lists the same states with live counts, says why rooms are waiting ("housekeepers start at 7:00", "all housekeepers busy", "new housekeepers start next hour", "no housekeepers hired", "housekeepers can't get to it"), and links to other floors that have dirty rooms waiting. The room inspector says the same for one room ("Being cleaned (40 min left)", "Dirty: waiting, all housekeepers busy").

## What's shown is what happens

`src/simulation/CleaningStatus.ts` works out each room's state at the current game time from the hour's staff plan: the itineraries the housekeepers on screen walk, and the plan `processCleaningTick` credits. So:

- a room is drawn "being cleaned" only while a housekeeper's stay in it is under way, and every housekeeper cleaning a room shows it so;
- the work left counts down through the hour exactly as it's being done, and at the end of the hour it equals what the tick leaves the room with;
- a turnover's progress is measured against its own size, recorded at checkout (`Room.cleaningHoursTotal`, including the extra hours a missing front desk adds), so changing the turnover quality later doesn't move the bar, and it never goes backwards.

`test/cleaningStatus.test.ts` checks all of this over 60 simulated days of the balanced bot, sampling six moments in every hour, as well as the wait reasons, the counts and the drawing itself (the real `renderCleaning` against a recording stand-in for Phaser's graphics).

## Seeing the map with the panel open

Panels float over the floor plan; on a phone they cover all of it. Every panel now has a minimize button: folded, it docks as a one-line bar just under the floor plan ("3 waiting · 1 being cleaned · 1 on the way · 1 daily clean · 2 grubby"), covering nothing, and the overlay stays on. A folded story log no longer counts as showing incidents, so they toast again while it's folded.

## Review

An adversarial review (three reviewers, each finding independently verified) confirmed ten distinct problems, all fixed with tests that fail without the fix (the styling ones checked in the browser):

- the progress bar reset every hour when there's no front desk, and jumped when the turnover quality changed;
- hiring the first housekeeper mid-hour said "all housekeepers busy" before anyone had arrived;
- a housekeeper on a walk lasting the whole hour (a room far upstairs) lost their claim on the room in the staff plan, so the room read "waiting". This was a staff planning bug: the worker now keeps the room through the walk;
- a turnover finished mid-hour was briefly tinted grubby;
- map dots and panel counts disagreed about daily cleans with a housekeeper on the way;
- the overlay's frame covered a worn room's condition bar;
- a lighter "under 70%" tint was labelled "hurts reviews" (it doesn't), and the blocked swatch didn't match the map;
- a folded story log suppressed incident toasts;
- an inspector hanging below the map covered the folded panel's buttons;
- the folded summary could say "all clean" with a grubby room on the map.
