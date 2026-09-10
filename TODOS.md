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

### Facility condition decay/repair mechanic

**What:** Give facilities condition decay and a `repairFacility()` function, mirroring how rooms already work.

**Why:** Facilities currently never degrade — `condition` is initialized to 100 and never touched again. This is inconsistent with rooms and may feel incomplete once players notice a gym that's been open for 200 days still shows 100% condition.

**Context:** The design doc's "Facility Decay/Repair Decision" defaults to "no decay" specifically because the decay branch is substantially bigger than a UI toggle: `MaintenanceManager.processMaintenanceTick` only iterates `state.rooms` today, `repairFacility()` doesn't exist (only `repairRoom()` does), and `FACILITY_CONFIG`'s `adjacentReviewBonus`/`starPoints`/`noiseOutput` are flat values that don't scale with condition the way room pricing/reviews do. Verified directly against `HotelState.ts` and `MaintenanceManager.ts` during plan-eng-review. "No decay" may simply be the right permanent design for facilities, not a placeholder — revisit only if it starts to feel like a real gap in play.

**Effort:** M
**Priority:** P3
**Depends on:** Facility parity (inspector UI) shipping first, so there's a UI surface to show condition/repair on.

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

## Infrastructure

### Deploy pipeline / distribution

**What:** Stand up the itch.io + GitHub Pages deploy pipeline specified in the original April 2026 design doc.

**Why:** The game has no live deployment today — it can't be shown to anyone. This becomes load-bearing the moment the founder revisits the deferred-validation checkpoint (now placed between PR1 and PR2, per the 2026-09-08 plan-eng-review) and wants to actually get it in front of a real player.

**Context:** The original 2026-04-09 design doc specified `itch.io` (free browser game) + GitHub Pages (`push to main = deploy`) with no pipeline complexity beyond that. The 2026-09-08 codebase survey confirmed this was never executed — no deploy config exists in the repo.

**Effort:** S
**Priority:** P2
**Depends on:** None — can happen anytime, but matters most once validation is back on the table.

## Completed
