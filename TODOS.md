# TODOS

## Testing

### UI/Phaser visual test infrastructure

**What:** Set up jsdom or Playwright so `GridRenderer`/`RoomInspector`/`FacilityInspector` rendering can be automated-tested.

**Why:** Right now all UI-layer claims (`party_guest`'s render color, the new facility inspector panel) are manual-QA only — zero regression protection on the entire Phaser layer.

**Context:** No jsdom/Playwright in `devDependencies` today. `test/simulation.test.ts` only covers the headless simulation layer via vitest's default Node environment; the UI layer has never had automated coverage. Surfaced during the plan-eng-review of the "Close the Gaps Before Story Generator" design doc when `party_guest`'s color-rendering and the new `FacilityInspector` both landed as manual-QA-only test items.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Exact numeric-search star-rating hint

**What:** Replace the algebraic `getNextStarRequirements` formula (from the star-rating drift-bug fix) with a numeric search over `calculateStarPoints()` so the hint is exact even when amenity tiers differ per room type.

**Why:** The chosen algebraic fix (D6, plan-eng-review 2026-09-08) assumes the amenity-points term is independent of `deluxePct`/`suitePct`, which isn't strictly true — `calculateStarRating` weights amenity points per room type by `count/total`, and different tiers per room type are explicitly supported. The approximation was accepted as good enough for now; this captures the fully-precise path.

**Context:** Only matters if a player sets noticeably different amenity tiers per room type (e.g. luxury on suites, basic on standard) while also actively chasing a star-rating hint. Caught by an outside-voice review pass during plan-eng-review; the design doc's own fix for the analogous "hardcoded vs. real formula" drift bug has this residual imprecision.

**Effort:** S
**Priority:** P4
**Depends on:** The star-rating drift-bug fix (calculateStarPoints extraction) shipping first.

## Simulation

### Remove unused Facility.condition

**What:** Delete `Facility.condition` (initialized to 100, never read) or fold it into `decor`.

**Why:** The original "facility condition decay/repair" idea is covered by the late-game economy milestone: facilities now have `decor`, which fades daily and is restored by renovation. The old `condition` field is dead weight.

**Effort:** S
**Priority:** P4
**Depends on:** None

## Balance

### Faster consequences for neglect

**What:** Make a hands-off hotel fail sooner and more visibly, e.g. broken rooms hurting reviews immediately, or out-of-order rooms still costing upkeep plus a reputation hit.

**Why:** An `idle` hotel (8 rooms, no changes) breaks down around day 70 but doesn't go bankrupt until ~day 200, because a broken room just goes quiet. The original target was ~30-50% bankrupt by day 90.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Bankruptcy threshold scaled to hotel size

**What:** Replace the flat -$10,000 bankruptcy line with one that scales with the hotel (e.g. a credit line based on property value), or warn well before it.

**Why:** A $1M+ hotel that hits a slow winter can go under over a ~$10k shortfall, because debt interest is 5%/day. The balanced bot only avoids this by keeping ~10 days of running costs in reserve; strategies that skip renovations still go bankrupt 8-13% of the time this way (docs/designs/floors.md).

**Effort:** S
**Priority:** P2
**Depends on:** None

## Floors

### Housekeeping is the hidden occupancy cap

**What:** Rebalance turnover cleaning so hiring housekeepers has diminishing returns. Options include shorter turnovers, a rising wage per extra hire, or the noise/review cost of a full hotel biting harder.

**Why:** Found while measuring staff travel time. The balance bots hire one housekeeper per 10 rooms and constantly have 15-20 rooms stuck waiting for cleaning. Hiring one per 7 rooms instead more than doubles a balanced hotel's day-400 valuation ($2.5M to $5.8M; reviews drop 7.5 to 6.4 as it fills up). Each housekeeper (~$60-130/day) unlocks hundreds of dollars a day in bookings, so "hire lots of housekeepers" is a dominant strategy, and every earlier balance pass was tuned against the understaffed bot.

**Effort:** M
**Priority:** P1
**Depends on:** None

### Floor-placement bonuses

**What:** Make where a facility sits matter: a rooftop pool, a ground-floor restaurant or shop that draws walk-ins, a lobby.

**Why:** Floors currently differ only by the view premium. Placement rules give the vertical layout decisions of its own, and read well in 3D.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Story Generator

### Always-on incident HUD/glanceability

**What:** Surface active-incident state (e.g. a Noise Complaint's escalation countdown) somewhere always visible, not just inside the toggle-able story log panel.

**Why:** The Story Generator design doc's Premise 3 calls the story log "persistent," but D6 (plan-eng-review, 2026-09-09) clarified this means retained scroll history, not always-on-screen — it follows the existing Finance/Staff toggle-overlay pattern (`GameScene.ts`). That means an in-progress incident's countdown is invisible unless the player has the panel open.

**Context:** Surfaced by the outside-voice pass during the Story Generator's plan-eng-review. Deliberately deferred rather than solved now — building new always-on screen real estate is real, unscoped layout work, and it's worth seeing whether toggle-panel visibility actually bothers anyone in play before committing to it.

**Effort:** M
**Priority:** P3
**Depends on:** The story log panel + at least one live incident chain (Noise Complaint) shipping first, so there's something to make glanceable.

### Guest name collision disambiguator

**What:** Add a disambiguator (e.g. a room-number suffix) for the story log when two simultaneously-checked-in guests share a generated name.

**Why:** `Guest.name` is drawn from a small hardcoded first-name pool (Satisfaction System Design, point 3) — with enough simultaneous guests, two can share a name, making a log entry like "Sam complained about noise" momentarily ambiguous about which Sam.

**Context:** Flagged as a known, accepted limitation in the design doc's third review round — not worth solving in the Story Generator milestone itself. Tracked here so it isn't rediscovered as confusing during a playtest.

**Effort:** S
**Priority:** P4
**Depends on:** `Guest.name` shipping first (Story Generator milestone).

### Remembered room-type influences return-guest matching

**What:** Make a returning guest's remembered room-type (from their prior stay) actually influence `matchGuestToRoom`'s assignment logic, instead of being log-flavor only.

**Why:** Satisfaction System Design, point 3 explicitly scopes the remembered room-type as cosmetic this pass ("Sam is back, hoping for another suite" is flavor text only) — it doesn't change which room Sam actually gets assigned.

**Context:** Explicitly named as future work in the design doc, consistent with Premise 5 (small starter catalog now, expand later). Tracked here so it's a deliberate backlog item rather than lost once the milestone ships.

**Effort:** S
**Priority:** P4
**Depends on:** `returningGuestPool` + arrival-generation hook shipping first (Story Generator milestone).

## Completed

- **Staff travel time** (2026-10-10): staff walk from the lobby or a staff closet; the walk costs cleaning and repair time. See docs/designs/hallways-and-people.md
- **Hallways, check-in desks, and people** (2026-10-10): hallway-connected rooms, desks staffed by front desk, walking guests and staff, bulldoze tool. See docs/designs/hallways-and-people.md
- **Multiple floors** (2026-10-10): stacked 8x5 floor plans, floors bought upward, elevator shafts, vertical noise, view premium, floor switcher. See docs/designs/floors.md
- **Late-game money sinks** (2026-10-10): prestige upkeep, decor + renovation, facility upgrades, marketing campaigns, valuation and endless legacy goals. See docs/designs/late-game-economy.md
- **Deploy pipeline** (2026-10-10): GitHub Actions runs tests + build on every push/PR and deploys `dist` to GitHub Pages from `main` -- https://daeyi.github.io/Hotel-Management-Game/
