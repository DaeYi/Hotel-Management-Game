# Design: Guest and Staff Personalities

Date: 2026-10-11
Status: PROPOSED
Follows: aligned-movement.md, open-floor-plan.md, late-game-economy.md
Builds on: the 11:00 checkout, guest day trips (`OutingManager.ts`, `GUEST_OUTINGS`) and presence-aware noise, which shipped together with this proposal (see aligned-movement.md).

## Request

> Come up with a list of attributes or personalities that staff/guests can have that help inform/guide their behavior.

The same request also asks for day outings, an 11:00 checkout and a room redesign (furniture, multi-bed rooms, suites with bedrooms). This document covers the personalities. It also explains how they create the demand that the room redesign meets.

## Rules every attribute follows

1. **What is shown is what is simulated.** An attribute either changes a person's itinerary legs (where they are, when, for how long, at what pace) or changes a number that the review or incident system already reads. Effects that are only numbers, such as review weights, must still show up somewhere the player reads: the inspector, a checkout write-up, or a story-log line.
2. **The player never places guests.** `matchGuestToRoom` does that. So guest attributes only become decisions through things the player controls: layout, room features, facilities, pricing, staffing and policies.
3. **Deterministic generation, never the shared PRNG.** Rolls use `hash01` on a stable id, as `FacilityManager` and `OutingManager` already do. Adding an attribute then never shifts the PRNG stream, and balance baselines stay comparable.
4. **Neutral equals today.** Each distribution averages to about 1.0 on every multiplier it touches. With every effect set to neutral, today's balance runs reproduce exactly.
5. **Every visible marker maps to something a 3D model can show:** an outfit, a prop, a posture, a walk speed, or a door hanger.

## Groundwork found in the code

These come before, or together with, the first attributes.

- **`GuestTrait` mixes three things.** It sets noise sensitivity (`light_sleeper`), noise output (`party_guest`) and budget (`big_spender`). They are mutually exclusive today (20/20/15, the rest normal). This design splits them into three independent attributes: Sleep sensitivity, Rowdiness and Spending style. `trait` remains only as a label worked out from those, for old saves and the transition.
- **Noise ignores whether anyone is home.**
  - `NoiseManager.calculateRoomNoise` counts every occupied neighbor room. Once outings ship, a room that is visibly empty will still make noise.
  - The review samples noise once, at the checkout tick (`calculateGuestReviewBreakdown`). That tick is now 11:00, so the review measures late-morning noise, not night noise.
  - Fix: noise comes only from guests whose legs put them in their room. A per-guest nightly tally (`Guest.noiseExposure`) is updated each hour, and the review and noise complaints read that tally.
- **A per-guest stay ledger.** Keep a small capped list of `{day, hour, kind, ref}` events: disturbed nights, facility visits, facility misses, queue waits, room moves. The review breakdown and the story log both read it, so they agree with each other and with what was on screen. Story entries use `chainId = guest.id`, so one guest's stay reads as one thread.
- **`matchGuestToRoom` assumes everyone takes the cheapest room.** Its `availableIdx` forward scan breaks as soon as anyone prefers a different room. Spending style, Loyalty and Mobility all do, so the scan has to become a taken-set.
- **Staff have no identity.**
  - `syncRoster` reuses ids (`housekeeper-0` goes to the next hire after a layoff). A personality hashed from the id would pass a fired worker's personality to their replacement.
  - Staff need a unique serial id from a hire counter, plus a name and `hiredDay`. The rolled profile is stored on `StaffMember`, not recomputed from the id.
  - `syncRoster` lets the newest hire go. With personalities, the player has to choose who goes.
  - Front desk staff are not on the roster at all. They are a count, drawn as `frontdesk-spare` figures, so desk personalities need a `front_desk` role first.
  - Wages become per person (`getStaffDailyCost`).
- **Outings are keyed by the old trait.** The in-progress `GUEST_OUTINGS.traitMult` should become per-purpose leave and return windows (see Purpose of stay).
- **Guest ids can collide.** Ids are `guest-${day}-${floor(prng * 100000)}`. Two guests that share an id would share every rolled attribute. This is rare, but a per-day counter in the id would remove it.

## Guest attributes

Guests are described along four rolled axes plus a derived status:

| Axis | Attributes | Question it answers |
|---|---|---|
| Trip | Purpose of stay, Party size | Why are they here, and who came |
| Body | Chronotype, Mobility | When and how they move |
| Temperament | Sleep sensitivity, Rowdiness, Patience, Voice | How they react to the hotel and to other people |
| Tastes | Spending style, Favorite facility, Housekeeping preference | What they want from the hotel |
| Status (derived, not rolled) | Loyalty tier, Spotlight guest, Mood | Their history with the hotel and how they feel now |

Purpose is rolled first and shifts the weights of the other axes; for example, business guests lean early bird, impatient and gym-loving. Apart from those documented biases, the axes are rolled independently.

### Trip

#### 1. Purpose of stay

Why the guest is here. It sets the template for their whole day.

- **Values:** business / sightseeing / getaway / event.
- **Mix:** starting numbers for tuning.
  - Weekdays: business 45, sightseeing 35, getaway 20.
  - Weekends: business 15, sightseeing 50, getaway 35.
  - Summer moves 10 points to sightseeing.
  - During a `SEASON.specialEvents` window, 30% of arrivals are event-goers.
- **Simulation:**
  - **Business:**
    - Schedule: stays 1-2 nights. Leaves 7-9 and comes back 17-19 on every day except checkout day.
    - Facilities: gym 6-8 and breakfast at the restaurant; never uses the pool.
    - Money: price tolerance spread +0.2, because the company pays.
    - Review weights: elevator wait and check-in wait ×2, price fairness ×0.6.
  - **Sightseeing:**
    - Schedule: stays 2-4 nights and is out 9-17 most days, for 4-8h.
    - Facilities: uses few.
    - Review weights: price fairness ×1.3, facilities ×0.5.
  - **Getaway:**
    - Schedule: rarely leaves (outing chance ×0.3).
    - Facilities: visit chance ×1.5.
    - Review weights: decor ×1.5.
    - A getaway couple gets the "honeymoon" label in the story log.
  - **Event:**
    - Schedule: stays for the days the event has left. Goes out 17-20 and comes back 23-01, which needs a per-purpose `latestReturnHour`.
    - Other: budget ×1.2, and leans rowdy.
  - Purpose replaces `GUEST_OUTINGS.traitMult` and its single `leaveChance` curve with per-purpose windows, and adds a purpose multiplier to `FacilityManager.visitChance`.
- **On screen:** the building empties at 8:00 on a weekday and fills again at 18:00. On a summer Saturday the pool fills and the hallways stay busy.
- **Hooks into:** `GuestManager.generateFreshGuest` and `processArrivals` (stay length, tolerance), `OutingManager`/`GUEST_OUTINGS`, `FacilityManager.visitChance`, `SeasonManager` (day of week, events), `calculateGuestReviewBreakdown` (weights), `ReturningGuestProfile`, a new `GUEST_PROFILE` table in `balance.ts`.
- **Player decision:** build for whoever is coming.
  - A weekday business crowd rewards a fast desk, enough elevators, a gym and a breakfast restaurant near the elevator.
  - A leisure weekend rewards the pool and the shop.
  - Business guests leave rooms empty all day, which gives a free window for daily cleans.
- **How the player learns it:**
  - Figure colour is purpose, replacing today's trait colours. Today those colours are never explained, and the big_spender red (`0xe74c3c`) and party_guest pink (`0xe91e63`) are nearly the same.
  - The legend lists the four purposes.
  - Inspector: "Business trip, 2 nights, out until about 18:00".
  - Story: "Conference crowd in for the Spring Festival", or "Kenji stayed three nights and never once saw the pool."

#### 2. Party size

How many people share the room.

- **Values:** solo (1) / couple (2) / family (2 adults and 1-2 kids) / group (3-4 friends). The mix depends on purpose:
  - Business: 85% solo.
  - Sightseeing and getaway: couple 45, family 30, solo 15, group 10.
  - Event: group 50, couple 30, solo 20.
- **Simulation:**
  - **Itinerary:** the party shares one itinerary, so alignment is untouched.
  - **Facility capacity:** each head takes a slot. A family of 4 takes 4 of the pool's 6 places.
  - **Shop spend:** scales per head; kids count 0.5.
  - **Occupancy factor:** 1 head ×0.8, 2 heads ×1.0, 3 heads ×1.3, 4 heads ×1.5. It scales cleanliness decay, amenity cost per night and turnover hours. The population mean stays about 1.0.
  - **Noise:** families add a little noise 6-9. Groups make ×1.5 noise 22-02.
  - **Room fit:** until rooms have beds, a standard takes up to 2 heads, a deluxe up to 3 and a suite up to 4. The matcher prefers an exact fit, so a solo guest doesn't take a family room.
- **On screen:** 1-4 figures walk together, one leader with followers half a tile behind (kids smaller), and the room shows that many dots.
- **Hooks into:** `Guest.party`, `matchGuestToRoom`, `FacilityManager.overlappingVisits` and `creditFacilityVisits`, `HousekeepingManager.degradeCleanliness` and `startTurnoverCleaning`, `EconomyManager.processDailyCosts`, `NoiseManager`, `ActorLayer` (followers drawn from one list of legs).
- **Player decision:** the room mix (twins and family rooms vs doubles), and pool or gym capacity upgrades when families crowd them.
- **How the player learns it:**
  - Inspector: "Family of 4".
  - Facility inspector counts heads: "5/6 inside".
  - Turn-away line: "Family of 4: no room with enough beds".

This is the demand side of the room redesign, and it should ship with it (see Later).

### Body

#### 3. Chronotype

The guest's daily rhythm. It moves their whole day and replaces a separate "timing" attribute.

- **Values:** early bird (sleeps 21-05, activities 2h earlier) / regular (23-07) / night owl (02-10, activities 2h later). Weights 25/55/20. Business guests and families lean early bird; event-goers and groups lean night owl.
- **Simulation:**
  - **Windows:** facility visit windows and outing departure and return times shift by the offset. `visitChance` is looked up at hour minus the offset.
  - **Sleep window:** sets when Sleep sensitivity and Rowdiness apply.
  - **Checkout hour:** each guest has their own, built around the new 11:00.
    - Early birds check out 7-10, freeing their rooms before the turnover rush.
    - Regulars check out at 11:00.
    - Night owls ask for 13:00. A late-checkout policy (deny / free / fee) decides. Refused night owls lose a little satisfaction. Granted ones push their turnover toward the 14:00 check-in.
  - The offsets average to zero, so total visits are unchanged; they are only spread across more hours.
- **On screen:**
  - A sleeping guest's room dims and shows "z" during their sleep window, the same window the noise code uses.
  - Night owls are seen walking back through the lobby after 23:00.
  - Early birds are seen in the gym at 6.
- **Hooks into:** `FacilityManager.visitChance`/`planFacilityVisits`, `OutingManager`, `GuestManager.isCheckoutDue` (per-guest hour instead of `ECONOMY.checkOutHour` alone), `NoiseManager`, a new policy field on `HotelState` with a toggle in the Housekeeping panel.
- **Player decision:**
  - The late-checkout policy trades fee revenue and happier night owls against rooms not ready at 14:00.
  - Where to put the gym and restaurant relative to rooms.
- **How the player learns it:**
  - Inspector: "Night owl, sleeps 2-10, late checkout 13:00".
  - Housekeeping panel: "Rooms due by 14:00: 6".
  - No icon of its own.

#### 4. Mobility

How fast the guest walks.

- **Values:** brisk 0.045 h/tile / normal 0.06 (today's `guestHoursPerTile`) / limited 0.09. Weights 15/75/10. Business guests lean brisk; families and older couples lean limited.
- **Simulation:**
  - **Pace:** a per-guest pace replaces the `PACE` constant in `GuestMovement`, `FacilityManager` and `OutingManager`. Legs already carry their pace, and route trees are already cached per pace, so this adds at most two cache keys.
  - **Facility reach:** `FACILITY_VISITS.maxWalkHours` scales with pace, so a limited guest won't walk to a far facility.
  - **Elevators:** limited guests take the elevator wait penalty ×1.5.
  - **Room choice:** limited guests prefer the acceptable room with the shortest walk from the desk (ground floor, or near an elevator).
- **On screen:** the figure is visibly slower or faster, straight from its legs, with no extra render code. In 3D, a cane or a luggage cart.
- **Hooks into:** `GuestMovement`, `FacilityManager`, `OutingManager`, `Layout.findRoute` cache, `matchGuestToRoom`, `HotelState.getElevatorWaitPenalty`.
- **Player decision:** elevator count and placement, keeping some good rooms near the lobby, and keeping facilities close to the core of the building.
- **How the player learns it:** inspector tag, plus story lines like "The Nakamuras took 25 minutes to reach breakfast."

### Temperament

#### 5. Sleep sensitivity

How much night noise bothers the guest.

- **Values:** heavy ×0.5 / normal ×1.0 / light ×2.0. These are today's `NOISE.traitNoiseSensitivity` numbers. Weights 20/60/20. Today's light_sleeper maps to light.
- **Simulation:**
  - **When noise counts:** only while the guest is physically in the room during their sleep window. Each hour, `noiseExposure += max(0, noise - threshold) × sensitivity`, alongside `driftSatisfaction`.
  - **Review:** the noise penalty becomes `penaltyPerUnit` × mean nightly exposure. `penaltyPerUnit` is calibrated so the mean penalty matches today's.
  - **Complaints:** a noise complaint can only fire inside the sleep window.
  - **Room choice:** light sleepers prefer rooms tagged Quiet (no facility or rowdy room next door), and will pay up to 15% more for one.
- **On screen:** a light sleeper's dimmed room shows a restless icon on nights they are woken. The noise overlay gets a Night view.
- **Hooks into:** `NoiseManager.noiseToRatingPenalty` and `calculateRoomNoise`, `Guest.noiseExposure`, `tick.ts`, `calculateGuestReviewBreakdown`, `matchGuestToRoom`, `StoryGenerator.collectCandidates`/`deriveSatisfactionTarget`.
- **Player decision:**
  - Build quiet floors, high up and away from the restaurant and the elevator.
  - Schedule renovations for daytime, when sleepers are out.
  - Price Quiet rooms higher.
- **How the player learns it:**
  - Moon icon (the guest's quirk icon, see Display).
  - Inspector: "Light sleeper, woken 2 nights of 3".
  - Complaints name the source: "the restaurant" or "the party in 2-05".

#### 6. Rowdiness

How much noise the guest makes.

- **Values:** quiet ×0.8 / normal ×1.0 / rowdy ×2.5, plus ×1.5 for rowdy guests from 22:00 to 02:00. Weights 20/65/15. Groups and event-goers lean rowdy. Today's party_guest maps to rowdy.
- **Simulation:**
  - **When noise counts:** a guest emits noise only while in their room and awake. A rowdy guest out at a bar is silent; one back at 1am is loud. `getLoudestNeighborGuestId` uses the same rule, so the culprit named in a complaint is someone who is really there.
  - **Cleanliness:** rowdy rooms lose cleanliness ×1.5 per day. This replaces a separate Tidiness attribute.
  - **Hosted night (Phase 2):** on one hash-chosen night per stay, a rowdy guest hosts 1-3 visitors.
    - The visitors walk in from the street around 22:00, go up to the room and leave at 01-02, making hallway noise on the way.
    - A new desk action, "Ask them to keep it down", sends the visitors out within the hour as a visible walk. It costs the host 10 satisfaction and resolves the complaint.
  - Once outings ship, total noise drops because absent guests stop emitting. Retune `penaltyThreshold` after both changes land.
- **On screen:** a pulsing noise ring on the room only during loud hours. Visitors are drawn in the host's colour.
- **Hooks into:** `NoiseManager.calculateRoomNoise`/`getLoudestNeighborGuestId` (needs the hour and `isGuestAway`), `GuestMovement`, `Walker` (new reason `visitor`), `StoryGenerator` noise-complaint chain (new resolution branch), `HousekeepingManager.degradeCleanliness`.
- **Player decision:** zone the building, with a party floor over the restaurant and a quiet floor up high. Use weekend price premiums to filter out cheap rowdy groups. When a party starts, choose between the host's review and the neighbour's.
- **How the player learns it:**
  - Music-note icon.
  - Story chain: "Room 2-04 has visitors" > "Ingrid in 2-05 complained" > "You asked 2-04 to keep it down; the visitors left at 00:40."

#### 7. Patience

How long the guest will wait.

- **Values:** patient (waits up to 1h, elevator penalty ×0.6) / normal (0.3h, ×1.0) / impatient (0.15h, ×1.5). Weights 25/55/20. Business guests lean impatient.
- **Simulation:**
  - **Queue:** check-in becomes a real queue that can run into the next hour, instead of `processArrivals` turning away everyone beyond the hour's desk capacity. Lane time already promised carries into the next hour (new `state.deskQueue`).
  - **Giving up:** a guest whose wait would exceed their patience walks out at that moment and counts in `totalTurnedAway`.
  - **Wait time:** `WAIT_IMPATIENT_HOURS` (0.3 today) becomes per guest.
  - **Timing:** this matters more with the 11:00 checkout, which pushes room availability, and so arrivals, toward 14-16.
- **On screen:** a visible line at the desk. A clock glyph appears over a waiting figure once it has used half its patience. Impatient guests are seen leaving the queue and walking out.
- **Hooks into:** `GuestManager.processArrivals`, `GuestMovement.planArrivalTrips` (lane availability across hours), `HotelState.getElevatorWaitPenalty`, `alignment.test.ts` (no more check-ins at once than seats).
- **Player decision:** front desk headcount and desk count against wages; a second entrance with a desk next to it; elevator count.
- **How the player learns it:** the queue itself, and a toast or log line: "Omar gave up after 40 minutes in line." No permanent icon.

#### 8. Voice

How the guest complains. This is what turns falling satisfaction into something visible.

- **Values:** vocal / typical / stoic. Weights 25/55/20.
- **Simulation:**
  - **Vocal:**
    - Eligible for incidents below satisfaction 45, instead of today's `incidentFuelThreshold` of 35.
    - Complains in person: walks from their room to a staffed desk for a 0.25h `complain` stay, which uses up a check-in lane for that time.
    - The incident opens when they reach the desk, and its grace period starts then.
  - **Typical:** today's behaviour, but the complaint is also an in-person desk trip.
  - **Stoic:**
    - Never files a complaint during the stay.
    - Review penalties ×1.3.
    - Twice as likely to be picked as the author of a semi-viral review.
- **On screen:** a guest walking down the hallway to the desk, at any hour, with a complaint bubble.
- **Hooks into:** `StoryGenerator.collectCandidates` (threshold per guest) and `selectNewIncident`, `GuestMovement` (complaint trip), `StayActivity` (add `complain`), `Layout.getCheckInCapacity` (lane time used by complaints), `calculateGuestReviewBreakdown`, `checkReviewSemiViral`.
- **Player decision:**
  - Vocal guests are a warning in time to fix the problem.
  - Stoic guests are hidden risk, which rewards fixing problems early and paying for a concierge (see Specialty).
  - Front desk staffing now covers two jobs: check-ins and complaints.
- **How the player learns it:** the inspector shows a mood face for vocal and typical guests, and "?" for stoic guests until checkout or until a concierge reads them.

### Tastes

#### 9. Spending style

How much the guest has to spend and how they spend it. Replaces big_spender.

- **Values:** thrifty (budget ×0.7, tolerance spread ×0.5) / standard / splurger (budget ×1.5, tolerance spread ×1.5). Weights 30/50/20, with splurger +5 points per star above 2. The existing `prng.range` budget roll is kept and only scaled.
- **Simulation:**
  - **Splurger:**
    - Room choice: takes the best room type they can afford and consider fair (suite, then deluxe, then standard, then the highest floor) instead of the cheapest. This needs the taken-set.
    - Spending: ×2 per shop visit, and runs a restaurant tab, which gives the restaurant a `spendPerVisit`.
    - Expectations: amenity and decor penalties ×1.2.
  - **Thrifty:**
    - Spending: never uses the shop.
    - Meals: eats out instead of using the restaurant, as an evening outing, leaving 18-19 and coming back 20-21.
    - Review weights: price fairness ×1.5, amenities ×0.5.
- **On screen:** thrifty guests leave for dinner; splurgers go to the shop and restaurant.
- **Hooks into:** `GuestManager.generateBudget`/`matchGuestToRoom`/`processArrivals`, `FacilityManager.creditFacilityVisits`, `FACILITY_CONFIG` (restaurant spend), `OutingManager` (dinner outing), `calculateGuestReviewBreakdown`.
- **Player decision:**
  - Pricing per room type chooses which guests come, not just how many rooms fill: cheap rooms fill with thrifty guests who buy nothing.
  - Luxury amenities and the shop pay off only if splurgers come.
- **How the player learns it:**
  - A "$" icon for splurgers only; thrifty guests show nothing.
  - Inspector: "Spent $84 here this stay".
  - The Finance panel splits revenue into rooms and on-site spend.
  - Story: "Malik ran up a $210 restaurant tab."

#### 10. Favorite facility

A facility the guest seeks out. Replaces the "interests" list from one proposal; one favourite is easier to read than a set.

- **Values:** none (about 55%) / gym / pool / restaurant / shop. Weighted by purpose: business toward gym and restaurant, getaway toward pool and restaurant, families toward pool.
- **Simulation:**
  - **Visits:** visit chance ×3 for the favourite, up to twice a day. For these guests only, the once-a-day rule is lifted.
  - **Non-fans:** the chance for guests who are not fans of a type drops by about ×0.75, so the mean visit rate per facility type matches today's.
  - **Review bonus:** a visit to the favourite gives a review bonus ×1.5, still under `maxBonusPerStay`.
  - **Misses:** when the favourite is missing or full, the guest records a "wanted" miss: −4 satisfaction and −0.3 review.
    - The miss counts only for facility types the hotel's star level has unlocked, so a 1★ hotel isn't punished for having no pool.
    - With no pool or restaurant, swimmers and foodies take an outing instead, visibly leaving for the beach or a restaurant down the street.
- **On screen:** guests head to the favourite at its hours. The facility glyph pops over the figure as it sets off.
- **Hooks into:** `FacilityManager.planFacilityVisits` (chance, once-a-day rule, record rejections), `facilityReviewBonus`, `OutingManager` (fallback outing), `HotelState.dailyStats` (wanted counts per type), `StoryGenerator.attributeReviewCause` ("no pool").
- **Player decision:** which facility to build or upgrade next, and where, using demand the player can see before spending $20k to find out.
- **How the player learns it:**
  - Inspector: "Loves: swimming (4 swims this stay)".
  - Facility inspector: "Turned back (full) today: 3; fans staying now: 7".
  - The build panel shows weekly "wanted" counts on facilities not yet built.
  - Story: "The honeymooners in 4-02 swam six times."

#### 11. Housekeeping preference

When the guest wants their room cleaned.

- **Values:** do not disturb / standard / make up daily. Weights 25/55/20.
- **Simulation:**
  - **Do not disturb:** the planner sends a housekeeper only inside the guest's away window, which is known from their trip legs. If the guest never leaves, the room is not cleaned. The cost applies only if cleanliness is below 50 at checkout.
  - **Make up daily:** queued every day even on an every-other-day cadence (charged `dailyCleaningCost`). Cleanliness review weight ×1.6.
  - **All guests:** `StaffManager.jobQueues` orders daily cleans so rooms whose guest is out at the planned time come first. Outings become cleaning windows.
- **On screen:** a hanger on the room's door bar. A housekeeper is seen going in only after the guest walks out.
- **Hooks into:** `HousekeepingManager.processDailyHousekeeping`/`estimateHousekeepingHours`, `StaffManager.jobQueues`/`planStaff` (uses `isGuestAway` at the planned time), `calculateGuestReviewBreakdown`, `alignment.test.ts` (no housekeeper ever in a DND room while its guest is present).
- **Player decision:**
  - Housekeeper headcount and cadence.
  - With outings and DND, daily cleans move from 10:00 toward midday and compete with the 11:00-14:00 turnover window. The options are more housekeepers, staggered shifts, or accepting skipped cleans.
- **How the player learns it:**
  - The hanger.
  - Housekeeping panel: "Daily cleans waiting for guests to leave: 4".

### Status (derived, not rolled)

#### 12. Loyalty tier

The guest's history with the hotel. Extends `isReturning`.

- **Values:** first visit / returning (2 stays) / regular (3-4) / VIP (5+).
- **Simulation:**
  - **Remembered profile:** `ReturningGuestProfile` gains a stay count, last room id, last review and the full personality, so the same person comes back with the same temperament and tastes.
  - **Room request:** regulars ask for their last room first, then its type. This closes the open item in story-generator.md: today `roomType` is cosmetic.
    - Given: +8 satisfaction (today's `regularReturnBonus`).
    - Taken, being renovated or demolished: −5 and a log line.
  - **Expectations:** ×0.9 for returning guests, ×0.85 for regulars, ×0.75 for VIPs.
  - **Weight:** regular and VIP checkouts count ×2 in the review window and in word of mouth.
  - **Losing a VIP:** a VIP who reviews below their last review leaves the pool, with a "lost a regular" story entry.
  - **Pool pull:** weighted by tier (VIP ×2), capped by `returningGuestPoolMaxSize`.
- **On screen:** the existing return ring changes colour, white then silver then gold.
- **Hooks into:** `ReturningGuestProfile`, `GuestManager.generateReturningGuest`/`processDepartures`/`matchGuestToRoom`/`getWordOfMouthMultiplier`, `EconomyManager.updateReviewScore`, `StoryGenerator.recordReturnGuestEntries`, `SaveManager`.
- **Player decision:**
  - Keep the rooms regulars want available, maintained and fairly priced.
  - Time renovations around their stays.
  - Decide whether holding a room for a regular is worth an empty night.
- **How the player learns it:** inspector "Sam, 6th stay", and one story thread per regular: "Sam's 4th stay: back in Room 2-04."

#### 13. Spotlight guest

A rare high-stakes guest. Merges the critic, influencer and travel-writer ideas.

- **Values:** none / travel writer / celebrity. At most one a week, from 3★.
- **Simulation:**
  - **Announced in advance:** 1-2 days ahead by the story log: "A travel writer arrives Friday and wants a suite."
  - **Travel writer:**
    - Tries every open facility type once (forced visit attempts).
    - Judges as if the hotel had one more star.
    - Their review counts ×5 in the rolling window.
    - A review of 8.5 or more starts a new "glowing write-up" modifier, +20% arrivals for 48h, the positive mirror of the semi-viral review. This needs `activeReputationPenalties` to allow multipliers above 1.
    - A review of 4 or less always starts the semi-viral penalty.
    - The write-up names the biggest bonus and the biggest penalty in the review breakdown.
  - **Celebrity:**
    - Wants a top-floor suite and pays ×2.
    - Always do not disturb.
    - Brings 10% more walk-ins that day.
- **On screen:** a gold figure, a notebook prop for the writer, and visibly tried facilities.
- **Hooks into:** `StoryGenerator` (advance-notice chain, positive counterpart to `checkReviewSemiViral`, `attributeReviewCause` extended to bonuses), `GuestManager.processArrivals` (scheduled arrival), `EconomyManager.updateReviewScore` (booking weight), `FacilityManager.planFacilityVisits`.
- **Player decision:** a short, concentrated prep.
  - Hold the suite empty, or renovate it in advance.
  - Put housekeeping on daily and pause nearby renovations.
  - Quiet the floor and staff up the desk.
- **How the player learns it:** a toast and story entry with a countdown, and the outcome logged at checkout: "The review is out: spotless pool, slow elevators."

#### 14. Mood

How the guest feels right now. This is derived from satisfaction every hour, with no roll.

- **Values:** delighted (75 or more) / content (50-74) / irritated (35-49) / angry (below 35).
- **Simulation:**
  - **Angry:** skips facility visits.
  - **Delighted:** spends ×1.5 at the shop and is 1.5× as likely to enter the return pool.
  - **Complaints:** together with Voice, Mood decides when someone walks to the desk.
- **On screen:** a mood face over the figure only when irritated or angry, to limit clutter.
- **Hooks into:** `FacilityManager.planFacilityVisits`/`creditFacilityVisits`, `GuestManager.processDepartures` (return pool), `StoryGenerator`.
- **Player decision:** fix the cause before guests start queuing at the desk.
- **How the player learns it:** the mood face, and a satisfaction bar in the guest inspector.

## Staff attributes

Rolled at hire and stored on `StaffMember.profile`. Dynamic values (hours worked, fatigue, morale) live in `StaffMember.stats`. They are updated at hour or day boundaries from the plan's own legs, so they always match what was shown.

#### 1. Experience

Skill that grows with work.

- **Values:** rookie (0-80 work-hours) / skilled (80-400) / veteran (400+). Hire mix 60/30/10.
  - Work rate ×0.8 / ×1.0 / ×1.2.
  - Wage ×0.8 / ×1.0 / ×1.3.
  - Front desk check-ins take 25 / 20 / 16 minutes.
- **Simulation:**
  - **Faster work:** `planStaff` sets a work stay to `job.hours / rate`, so a veteran visibly leaves a room sooner. `plannedWork` credits stay-hours × rate.
  - **Growth:** experience grows only from clean and repair stays actually in the plan.
  - **Level-up:** asks for a raise. Accept, or risk the worker quitting (see Morale).
  - **Balance:** a veteran is slightly worse per dollar but buys quality. A rookie breaks even and grows. Neither dominates.
- **On screen:** shorter or longer in-room stays.
- **Hooks into:** `StaffManager.planStaff`/`plannedWork`/`rosterAfter`/`syncRoster`, `HousekeepingManager.processCleaningTick`, `MaintenanceManager.processMaintenanceTick`/`getStaffDailyCost`, `GuestMovement` (check-in time per lane worker, once the desk is on the roster).
- **Player decision:**
  - Hire cheap and grow, or pay for veterans now.
  - Who to let go in winter. Letting a veteran go throws their experience away.
- **How the player learns it:** 0-2 chevrons on the uniform and on staff list rows, which show the rate ("cleans 1.2×") and the wage.

Walking pace is folded in here and not offered as its own attribute. On screen it reads the same as experience.

#### 2. Work style

Speed against thoroughness. The styles differ in kind; none is better overall.

- **Values:** speedy / standard / meticulous. Weights 25/50/25.
- **Simulation:**
  - **Speedy:**
    - Housekeeping: time ×0.8, and leaves cleanliness 10 below the hotel-wide turnover-quality result.
    - Maintenance: stops repairs at condition 85.
  - **Meticulous:**
    - Housekeeping: time ×1.25 and cleanliness +10, capped at 100.
    - Maintenance: repairs to 95.
    - Reports damage: cleaning a room below condition 60 queues a maintenance job.
  - **Who gets credit:** the result comes from whoever finished the room, so `plannedWork` has to be keyed per staff member.
- **On screen:** cleaning stays are visibly shorter or longer.
- **Hooks into:** `StaffManager.planStaff`/`jobQueues`, `HousekeepingManager.processCleaningTick`, `MaintenanceManager.processMaintenanceTick`, `HOUSEKEEPING.turnoverCleanlinessResult`.
- **Player decision:**
  - Mix the crew: speedy housekeepers for the 11:00-14:00 turnover rush, meticulous ones for suites and 5★.
  - The style interacts with the hotel-wide turnover-quality setting.
- **How the player learns it:**
  - Icon on the hiring card and staff row.
  - Room inspector: "Cleaned by Priya (meticulous): 95%".
  - Story: "Elena found a broken shower in 2-03 during her clean."

#### 3. Specialty

Which work this person picks first. The player can reassign it.

- **Values:**
  - Housekeeper: turnover runner (turnovers first, today's behaviour) / room attendant (daily cleans first, rooms with guests out first).
  - Maintenance: responder (worst vacant room first, today's behaviour) / preventive (also services occupied rooms below 40 while the guest is out, topping them up to 85).
  - Front desk: greeter / upseller / concierge.
    - Upseller: offers splurgers a better room type at its price. A quarter accept when one is free.
    - Concierge: identifies spotlight guests early and reads stoic guests' mood.
- **Simulation:**
  - **Ordering:** each member has their own order in `jobQueues` and their own claim order.
  - **Preventive repairs:** planned only inside the guest's away window, taken from their trip legs, and finished before the guest returns. They are itineraries like any other, so they stay aligned. Preventive work lowers mid-stay breakdowns; watch that it doesn't make maintenance dominant.
- **On screen:** who goes where. A maintenance figure in an occupied room while its guest is visibly out.
- **Hooks into:** `StaffManager.jobQueues`/`planStaff`, `GuestMovement.isGuestAway` (interval check), `MaintenanceManager.processMaintenanceTick` (allow occupied rooms whose guest is out), `GuestManager.processArrivals` (upsell), `StoryGenerator` (fewer breakdowns, upsell lines).
- **Player decision:**
  - Crew makeup for the turnover rush vs the daily round.
  - Preventive maintenance as insurance against breakdowns.
  - Who sits at the desk.
- **How the player learns it:**
  - Inspector: "Specialty: room attendant".
  - Story: "Dmitri fixed the AC in 3-04 while the guests were out sightseeing." / "Leo upsold the Parks to a suite (+$120)."

#### 4. Stamina and fatigue

Energy across a shift. This gives break rooms a real job; today they are only waiting spots.

- **Values:** stamina low / normal / high, rolled at hire. Fatigue (0-100) rises 9 / 7 / 5 per work-hour; walks and elevator rides count. Fatigue recovers 25/h in a break room and 10/h resting elsewhere, and resets overnight.
- **Simulation:**
  - **Tired:** at fatigue 60 or more, work rate ×0.85.
  - **Break:** at 85 or more, `planStaff` inserts a real 0.5h rest stay at the nearest break room (limited by `BREAK_ROOM` seats) before the next job.
  - **Exact tracking:** fatigue is updated in `rosterAfter` from the plan's own legs, so it is exact.
  - **Tuning target:** a crew with a break room on each busy floor loses under 5% throughput.
- **On screen:** workers walk to the break room mid-shift and rest there with a "z".
- **Hooks into:** `StaffMember.stats.fatigue`, `StaffManager.planStaff`/`restingPlace`/`rosterAfter`, `Layout.getAccessibleBreakRooms`, `BREAK_ROOM`, `alignment.test.ts` (breaks happen inside break rooms).
- **Player decision:** a break room on each floor vs longer walks to one, and staffing slightly above the minimum so breaks don't stall turnovers at 13:00.
- **How the player learns it:**
  - Energy bar in the staff inspector.
  - Staff panel hint: "Floor 4 staff walk 6 min to a break".
  - Story: "Dmitri dozed off in the break room for an hour; three rooms waited."

#### 5. Reliability

Attendance.

- **Values:** dependable (never late, wage ×1.1) / normal (late up to 1h on 5% of days) / flaky (late 0.5-2h on 20% of days, absent on 4%, wage ×0.9).
- **Simulation:**
  - **Daily rolls:** lateness and absence come from `hash01(staffId|day|late)` and `hash01(staffId|day|absent)`.
  - **Late:** the commute leg moves later, and the worker walks in mid-morning.
  - **Absent:** the worker doesn't arrive and isn't paid.
  - **Collision with checkout:** late mornings run into the 10:00 daily round and the 11:00 checkouts.
  - **Balance:** a flaky worker's expected lost hours roughly match the 10% wage discount.
- **On screen:** a lone figure walking in at 7:30. An empty slot on the shift timeline.
- **Hooks into:** `StaffManager.isOnShift`/`planStaff` (commute per member), `MaintenanceManager.getStaffDailyCost`, `StoryGenerator`.
- **Player decision:** a cheap flaky crew needs spare headcount. Dependable staff are worth it at 5★ and on a spotlight guest's day.
- **How the player learns it:** a toast at shift start ("Jordan called in sick, 6 rooms waiting") and an attendance record in the staff list.

#### 6. Shift pattern

When the person works.

- **Values:** full day 6-22 (today) / early 6-14 / late 14-22 / night 22-6 (front desk and maintenance only, +25% pay). Part-timers on early and late shifts are paid 0.55× the full-day wage.
- **Simulation:**
  - **Per-member shifts:** `isOnShift` and `shiftOf` become per member, and commutes happen at each person's own shift edges.
  - **Coverage:**
    - Early shifts cover the 10:00 daily round and the 11:00 turnovers.
    - Late shifts cover evening turnovers from walkouts.
    - A night desk extends check-in.
  - **Capacity:** `housekeepingHoursAvailable` sums each member's shift hours.
  - **Balance:** a part-timer gets 50% of the hours for 55% of the wage, so a part-timer only pays off when their hours match the load curve.
- **On screen:** a visible shift change at 14:00, with people commuting in and out.
- **Hooks into:** `StaffManager.isOnShift`/`shiftOf`/`planStaff`, `HousekeepingManager.processCleaningTick`/`housekeepingHoursAvailable`/`housekeepersNeeded`, `STAFF.*.workStartHour`/`workEndHour`, `Layout.getCheckInCapacity` (per hour), StaffPanel.
- **Player decision:** shape coverage to the day's load curve, which the 11:00 checkout makes peaky.
- **How the player learns it:** the Staff panel becomes a 24-hour timeline, one bar per person, drawn over the hourly workload curve.

#### 7. Hospitality

How the person treats guests.

- **Values:** warm / polite / curt. Weights 25/50/25.
- **Simulation:** applies only where staff and guests actually meet in the simulation.
  - **Check-in:** the guest's satisfaction changes by +4 / 0 / −3, and the check-in takes 0.25 / 0.33 / 0.4h. The mean stays at today's 0.33h.
  - **Complaints:** a warm clerk on duty gives a complaint +10 satisfaction when handled at the desk, and noise complaints get 3 more hours of grace.
  - **Housekeeping:** a daily clean done while the guest is in the room (not DND) adds +2 / 0 / −2.
- **On screen:** faster check-ins at a warm clerk's lane, and a small smile pop over the guest.
- **Hooks into:**
  - `StaffRole` gains `front_desk` on the roster. Named desk figures replace `frontdesk-spare`.
  - `Layout.getCheckInCapacity` becomes the sum of each seated clerk's rate.
  - `GuestMovement.checkInLanes`/`planArrivalTrips` (`CHECK_IN_HOURS` per lane).
  - `StoryGenerator.advanceIncidents` (grace hours).
  - `HousekeepingManager.processCleaningTick`.
- **Player decision:** put warm staff at the busiest desk and on daily rounds at 4-5★, and curt staff on turnovers and empty floors.
- **How the player learns it:** a trait on the hiring card and staff row, and story lines like "Sam's review: Nadia at the desk made our trip."

#### 8. Morale

How the person feels about the job. This is the staff version of guest satisfaction.

- **Values:** 0-100, worked out once a day at hour 0 from:
  - backlog hours per worker;
  - average fatigue;
  - wage compared with the star-level norm;
  - break-room access;
  - a coworker being let go (down);
  - good reviews (up).

  Bands: motivated (70 or more, rate ×1.05) / okay / fed up (below 35, rate ×0.9).
- **Simulation:**
  - **Quitting:** fed-up workers quit with a 3% daily chance (`hash01(staffId|day|quit)`) after 2 days' notice. A quit lowers `state.staff`, marks the worker `leaving`, and they walk out through the entrance.
  - **Raises:** a +10% raise restores morale.
  - **Balance:** understaffing now costs people, which reinforces the intended strategy order. The bots in `strategies.ts` need a rehiring rule.
- **On screen:** a figure walking out mid-shift.
- **Hooks into:** `StaffMember.stats.morale`, a daily staff step in `tick.ts`, `StaffManager.syncRoster`, `StaffConfig`, `StoryGenerator` (notice and quit entries within the pacing budget), `strategies.ts`.
- **Player decision:** give a raise or replace the worker (replacing loses experience); build break rooms; staff to the real load.
- **How the player learns it:** a face glyph in the staff list, average morale in the Staff panel, and story lines like "Priya gave notice after a week of double turnovers."

#### 9. Cross-trained

The person can cover a second role.

- **Values:** none / housekeeper who can work the desk / desk clerk who can clean. Cross-trained staff are paid +15%.
- **Simulation:**
  - **Housekeeper at the desk:** when their own queue is empty, takes a free desk seat and opens a check-in lane during the afternoon arrival peak.
  - **Clerk cleaning:** helps with turnovers before 14:00.
  - **Lanes:** check-in lanes come from the staff actually seated, not from a count.
- **On screen:** a two-tone uniform (housekeeping teal and desk blue), with the person visibly switching posts.
- **Hooks into:** `StaffManager.planStaff` (the idle branch can claim a desk seat), `GuestMovement.checkInLanes`, `Layout.getMannedDeskStaff`, `ActorLayer`.
- **Player decision:** one flexible crew instead of two single-role crews each sized for its own peak. With the 11:00 checkout, turnovers peak late morning and check-ins peak in the afternoon.
- **How the player learns it:** the hiring card, and the uniform on the floor plan.

## How generation works

**Guests.** Rolled once at arrival in `generateFreshGuest`, in a fixed order, each axis from `hash01(`${guest.id}|<axis>`)`:

1. **Purpose.** Weights come from `SeasonManager.getDayOfWeek`, the season, any active special event, and the star level.
2. **Party.** Conditional on purpose.
3. **Body, Temperament and Tastes.** Each is conditional on purpose and party through small weight shifts in `GUEST_PROFILE` (`balance.ts`).

After arrival:

- **Hourly choices** (whether to go out this hour, which facility, a hosted night) stay as they are today: `hash01(`${id}|${day}|${hour}|...`)`.
- **Derived values** (Mood, noise exposure, the stay ledger, Loyalty tier) are recomputed from state with no randomness.
- **Returning guests** keep Body, Temperament and Tastes from `ReturningGuestProfile`. Purpose and Party are re-rolled for the new trip; see open questions.

Keeping the PRNG stream stable during the transition:

- `generateGuestTrait(prng)` draws from the shared PRNG today. Phase 1 keeps that draw.
- The drawn trait sets Sleep sensitivity, Rowdiness and Spending style: light_sleeper to light, party_guest to rowdy, big_spender to splurger, with their axis default otherwise.
- The new axes come only from hashes.
- The stream is then unchanged, and with neutral effects the runs match today's bit for bit.
- When all three trait-derived axes move to hash rolls, a single balance pass measures the change.

**Staff.**

- **Rolled at hire:** each new hire gets a unique serial id from a hire counter on `HotelState`. Each axis is rolled from `hash01(`${serialId}|<axis>`)` and stored on `StaffMember.profile`; it is never recomputed from the id.
- **Hiring:** each role gets a daily shortlist of 3 candidates, worked out from `hash01(role|day|slot)`, so it needs no saved state. Hiring copies the candidate's profile. The +/− headcount buttons stay as a "hire best value" shortcut for players who don't care, and for bots and tests.
- **Layoffs:** the player picks who goes. Bots and the shortcut let the lowest-value member go.

**Saves.** The next save version:

- maps `trait` to the new axes;
- hashes the remaining axes for guests in the building;
- gives existing staff a neutral profile (skilled, standard, dependable, full day, polite, normal stamina), which reproduces today's numbers exactly.

**Balance method.**

1. Run with every effect neutral and confirm the runs match today's bit for bit.
2. Turn on one attribute at a time with `npm run simulate -- 400 12`. Each should move the median valuation by no more than ±5%. Then tune the set together.
3. The strategy order balanced > under-staffed / over-staffed > hoarder must still hold.
4. Purpose, Chronotype and Shift pattern partly relieve the turnover squeeze that the 11:00 checkout creates. Measure them together with that rebalance, not on their own.

**Tests.**

- One unit test per attribute, for example:
  - visit hours shift by the chronotype offset;
  - a guest's pace is carried in their legs;
  - DND skips the clean while the guest is in;
  - a fatigue break is a real leg;
  - a complaint uses up a desk lane.
- Extend `alignment.test.ts`:
  - noise comes only from guests who are in their room;
  - per-member work rates match the credited work;
  - breaks happen inside break rooms;
  - desk lanes, including complaints, never exceed seats;
  - preventive repairs and DND cleans happen only while the guest is out;
  - visitors and quitters leave by an entrance;
  - facility headcount never exceeds capacity.

## Display budget

Fourteen guest attributes cannot all be icons. The rule:

- **Figure colour:** Purpose (4 colours, in the legend).
- **Number of figures:** Party size.
- **Ring:** Loyalty tier. **Gold figure:** Spotlight guest.
- **At most one quirk icon,** in priority order: light sleeper (moon) > rowdy (music note) > splurger ($). The favourite-facility glyph appears only while the guest is heading there.
- **Door hanger:** Housekeeping preference.
- **Mood face:** only when irritated or angry.
- **No icon; seen through behaviour:** Chronotype, Mobility, Patience and Voice show up as when people leave, how fast they walk, how long they wait and who walks to the desk.
- **The rest** goes in a new click-a-figure inspector (guests and staff): name, attribute tags, current activity ("at the Pool", "resting: energy 22"), and what they liked or disliked so far.

Staff get experience chevrons, plus one or two traits on the hiring card and staff row. Morale and fatigue are the only changing values shown.

## Link to the room redesign

The player never assigns guests to rooms, so guest attributes become room decisions only if rooms have features the matcher respects:

- **Party size** needs beds: rooms that sleep N, with twin, family and suite layouts. Suites with separate bedrooms suit families.
- **Spending style** fills larger deluxe rooms and suites, and luxury fittings such as a tub or a minibar.
- **Purpose:** business guests value a desk and fast access to the elevator; getaway guests value decor and a view floor.
- **Sleep sensitivity** values a Quiet tag (no facility or rowdy room next door) and, later, soundproofing as a room feature.
- **Mobility** values rooms near an elevator or the lobby.

`matchGuestToRoom` should prefer a fitting room at an acceptable price, and the room inspector should say who a room suits: "Good for: families, light sleepers." Turn-away lines ("Family of 4: no room with enough beds") show the player the demand they are missing.

## Phase 1

Build the attributes that ride on the outing and 11:00 checkout work and are visible at once:

- **Groundwork:**
  - `Guest.profile` with hash rolls and a `GUEST_PROFILE` table.
  - Presence-aware noise and the nightly noise tally. Outings and the 11:00 checkout break the current noise model anyway.
  - The legend fix and a first guest inspector.
- **Purpose of stay** (business, sightseeing, getaway). It replaces `GUEST_OUTINGS.traitMult` with per-purpose windows and adds purpose multipliers to facility visit chance.
- **Chronotype.** Shifted windows, a sleep window and a per-guest checkout hour. Early birds check out before 11:00. Night owls check out at 11:00 until the late-checkout policy exists.
- **Favorite facility,** with "wanted" counts in the facility inspector.
- **Loyalty tier** and **Mobility,** both small.
- **The legacy trait** sets Sleep sensitivity, Rowdiness and Spending style at today's numbers.
- **Daily cleans** go to rooms whose guest is out first.
- **Staff:**
  - Identity (serial id, name, `hiredDay`, stored profile, per-person wage).
  - Experience, Work style and Reliability.
  - A minimal 3-candidate hiring card.

## Later

In rough order:

1. **Temperament and housekeeping.** Sleep sensitivity and Rowdiness split out and hashed. Hosted nights with visitors and the "keep it down" action. Housekeeping preference hangers. The late-checkout policy toggle.
2. **Queues and complaints.** Patience (the desk-queue rewrite), Voice and Mood complaint trips.
3. **Money and spotlight.** Spending style room choice (taken-set) and the restaurant tab. Spotlight guests and the "glowing write-up" modifier. Event-goers as a fourth purpose.
4. **Staff load.** Stamina and fatigue with break rooms, and Specialty.
5. **Front desk and shifts.** Front desk on the roster, Hospitality, Cross-trained, Shift pattern.
6. **Morale and quitting,** with a rehiring rule for the bots.
7. **Party size,** together with beds and furniture in the room redesign.
8. **Demand by purpose,** replacing the flat `weekdayDemand` 0.8 / `weekendDemand` 1.5. Early check-in and bag drop. Hallway meetings between staff and guests.

**Cut or folded:**

- **Folded into other attributes:**
  - A separate Tidiness attribute: covered by Party size and Rowdiness.
  - A separate Timing attribute: covered by Chronotype and the checkout policy.
  - A continuous reviewer-influence weight: a hidden number, folded into Spotlight.
  - Staff walking pace: reads like Experience on screen.
  - Hidden pickiness: star expectations and Spending style already cover it.
  - A random daily mood: `guestVariance` already supplies noise.
- **Cut:**
  - Hidden critics: an unfair surprise unless announced.
  - Nationality and language: a weak lever and a stereotyping risk.
  - Smoking, allergies and diet: no lever without menus or smoking rooms.
  - A "home floor" speed bonus for staff: micromanagement with no visible signal.
  - Noisy staff: only worth it if repair noise is modelled.
- **Deferred:** pet owners, until rooms have features.

## Open questions for the owner

1. **Figure colour.** Should it switch from trait to Purpose of stay? This removes the current unexplained trait colours.
2. **Late checkout.** Should the policy (deny / free / fee) ship with the 11:00 rebalance? Should business and early-bird guests have their own earlier checkout hours, which spreads the turnover load?
3. **Returning guests.** Should they keep their purpose (the honeymooners come back for an anniversary) or re-roll it for each trip?
4. **Staff choices.** Do you want hiring and layoffs to become choices about specific people (a candidate shortlist, picking who leaves)? Or should headcount stay a number, with personalities assigned automatically?
5. **Quitting.** Is it acceptable for staff to quit on their own, given that it makes understaffing compound?
6. **Spotlight guests.** Always announced in advance? Or hidden unless a concierge spots them, at the cost of a surprise penalty for players without one?
7. **Party size before the room redesign.** Should it wait for the redesign, or ship early with the interim rule (standard 2, deluxe 3, suite 4)?
8. **Demand mix.** Should purpose eventually change how many guests arrive (busier business weekdays), or only who arrives?
9. **Night shift.** Is a night desk or night maintenance worth having before the game models anything happening overnight besides noise?
