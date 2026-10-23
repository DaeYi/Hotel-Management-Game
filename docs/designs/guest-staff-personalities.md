# Design: Guest and Staff Personalities

Date: 2026-10-11
Status: IN PROGRESS. Purpose of stay (three values) and room preferences shipped first, as a slice: see guest-preferences.md. The remainder is being built in six phases (see "Build plan (2026-10-12)" at the end).
Current implementation: phase 3c (event visitors), phase 4 (named housekeeping and maintenance staff), and phase 5's named front desk, shifts, specialties, hospitality, stamina and fatigue are implemented. See the implementation notes below. Cross-training and morale remain in phases 5-6.

### Stamina, fatigue and break rooms implementation (2026-10-23)

- New candidates independently roll low/normal/high stamina at 25/50/25 without consuming the shared PRNG or changing wage agreements. Actual work, counter duty, walks and lift rides add 7/5/3 fatigue per hour. At 60 fatigue work rate is 0.85; at 85 staff take a half-hour break. Room work splits at energy thresholds; a committed occupied-room visit exits safely before a compulsory break, and desk service already underway keeps its agreed duration.
- Breaks are actual walking and rest legs. The nearest reachable break room must have a seat free for the entire stay; all roles share its six seats. A full or disconnected room has a slower rest fallback at a staff base or outside a guest room. Rest restores 25 energy/hour in a reserved room and 10 elsewhere. Ordinary idle recovery can be interrupted by new work; a compulsory break keeps its fixed end across hour boundaries, paused edits and reloads.
- Fatigue is committed once per hour from clipped actual itinerary time. Temporary mid-hour replans project energy without crediting the preserved past twice. Off-duty time restores 25/hour rather than resetting at midnight, so overnight shifts continue honestly. Existing staff default to normal stamina and zero fatigue; additive optional fields use save v22 and preserve identities, wages, experience and current plans.
- The team and inspector show stamina, live energy, tired status and actual recovery. Staff resting on the floor show a small z. The staff panel lists reachable break rooms, seat occupancy and the recovery advantage. Staffing advice budgets recovery time; simulation strategies reserve space and build break rooms once a floor has six rooms. Idle recovery compares the energy restored by the next planning point with a nearby base, avoiding long walks that would recover no extra energy. Held-suite readiness accounts for projected fatigue, breaks and return walks.
- Morale, raises, quitting and cross-training remain separate milestones.

### Specialties and hospitality implementation (2026-10-21)

- Specialties are role-specific and reassigned from the team list or staff inspector, with no wage or experience reset. Turnover runners retain the original order; room attendants prefer daily rounds, with parties out first. Responders retain vacant-room repairs; preventive workers use spare capacity to service occupied rooms below 40 to 85, only when approach, remaining work and exit fit the whole party's away window and the shift. They skip DND rooms. Work goals and contributions survive hourly planning and mid-hour changes.
- Greeters keep normal reception duties. Upsellers offer splurgers a higher room class with deterministic 25% acceptance, beyond the splurger's ordinary self-selected trade-up cap but within their original fair-price tolerance and budget. Only suitable, reachable free rooms are offered; held suites, a regular's promised old room and active repair targets are protected. Upgrades keep movement history, finish a step already underway and route from the guest's real position. A room already entered needs turnover cleaning. Billing uses the new room's actual rate; the story names the clerk and premium.
- Concierges reveal a stoic guest's mood after that guest's own check-in or desk complaint. Early spotlight identification was superseded by the owner's always-announced spotlight policy, so this adds no hidden announcement or demand roll.
- New desk and housekeeping candidates roll warm/polite/curt at 25/50/25, independently of experience and reliability, with wage multipliers 1.15/1/0.9. Desk service multiplies the experience duration by 0.75/1/1.2 and gives +4/0/−3 mood. A warm desk complaint gives 10 total mood (normal heard benefit: 5); a physically present warm clerk grants phone noise complaints three additional grace hours once when filed. Daily cleans give +2/0/−2 only when the actual finisher meets the guest in the room, never for DND or an absent guest.
- A bounded per-stay encounter history identifies the staff involved. Net hospitality contributes 0.05 review points per mood point, capped at ±0.6/10. The guest inspector and a daily named checkout write-up show that same component. Repeated credit, reloads and a history reaching its cap cannot award an encounter twice. Queued service snapshots change on reassignment; service already underway keeps its original duration and traits.
- Save v22 remains compatible: the new fields are optional and stored by the existing serializer. Missing hospitality is polite and missing specialties retain original priorities; old employees, wage agreements, experience and plans are preserved. Feature switches are separate, and no added roll consumes the shared PRNG.
Follows: aligned-movement.md, open-floor-plan.md, late-game-economy.md
Builds on: the 11:00 checkout, guest day trips (`OutingManager.ts`, `GUEST_OUTINGS`) and presence-aware noise, which shipped together with this proposal (see aligned-movement.md).

## Owner decisions (2026-10-11)

- **Staff hiring is a choice of specific people.** Each role gets a shortlist of candidates with names, traits and wages, and the player picks who to hire and who to let go. The +/- buttons stay as a "hire the best value" shortcut. This is open question 4.
- **Parties are shown as several people walking together** (from the rooms decision). This settles Party size's on-screen form: N figures on one itinerary.

## Owner decisions (2026-10-12)

- **Figure colour is purpose** (open question 1): shipped with guest-preferences.md.
- **Late checkout is a policy toggle** (open question 2): deny / free / fee, in the Cleaning panel. Early birds check out 07-10, regulars at 11:00, night owls ask for 13:00.
- **Staff may quit** (open question 5): fed-up staff give 2 days' notice and walk out; raises and break rooms restore morale; the bots get a rehiring rule.
- **Spotlight guests are always announced** (open question 6), 1-2 days ahead in the story log.
- **Purpose shapes who arrives, not how many** (open question 8): the weekday and weekend demand multipliers stay.
- Not asked, so the defaults stand: returning guests keep their Body, Temperament and Tastes and re-roll Purpose and Party (open question 3); no night shift until something happens overnight besides noise (open question 9).

## Request

Owner update (2026-10-18): front desk clerks work shifts now, and multiple clerks are required for 24-hour coverage. This supersedes the earlier default of postponing night shifts.

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
  - Wage ×0.9 / ×1.0 / ×1.3 (rookie discount tuned in phase 4).
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

- **Values:** stamina low / normal / high, rolled at hire. Fatigue (0-100) rises 7 / 5 / 3 per work-hour; walks and elevator rides count. Fatigue recovers 25/h in a break room, 10/h resting elsewhere and 25/h off duty; midnight itself does not reset it.
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

- **Values:** dependable (never late, wage ×1.1) / normal (late up to 1h on 5% of days) / flaky (late 0.5-2h on 20% of days, absent on 4%, wage ×0.95).
- **Simulation:**
  - **Daily rolls:** lateness and absence come from `hash01(staffId|day|late)` and `hash01(staffId|day|absent)`.
  - **Late:** the commute leg moves later, and the worker walks in mid-morning.
  - **Absent:** the worker doesn't arrive and isn't paid.
  - **Collision with checkout:** late mornings run into the 10:00 daily round and the 11:00 checkouts.
  - **Balance:** absence is already unpaid. A 5% wage discount compensates for lateness and uncertainty; a larger discount made surplus unreliable staff too profitable in phase 4's balance runs.
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
4. ~~Staff choices~~ **Decided:** hiring and layoffs are choices about specific people (a candidate shortlist, picking who leaves).
5. **Quitting.** Is it acceptable for staff to quit on their own, given that it makes understaffing compound?
6. **Spotlight guests.** Always announced in advance? Or hidden unless a concierge spots them, at the cost of a surprise penalty for players without one?
7. **Party size before the room redesign.** Should it wait for the redesign, or ship early with the interim rule (standard 2, deluxe 3, suite 4)?
8. **Demand mix.** Should purpose eventually change how many guests arrive (busier business weekdays), or only who arrives?
9. **Night shift.** Is a night desk or night maintenance worth having before the game models anything happening overnight besides noise?

## Build plan (2026-10-12)

Each phase ships on its own (tests, an adversarial review, a 12-seed 400-day balance sweep, deploy):

1. **Guests' rhythms.** 1a: `Guest.profile`, Chronotype with the late-checkout policy, Mobility, Sleep sensitivity and Rowdiness with the nightly noise tally, quirk icons and a guest inspector. 1b: Favorite facility, Loyalty tier, Mood.
2. **Guests and service.** Housekeeping preference, hosted nights and "keep it down", Patience and the desk queue, Voice and complaint trips.
3. **Money and spotlight.** Spending style, the restaurant tab, Spotlight guests and the glowing write-up, event-goers.
4. **Staff identity.** Serial ids, names, the 3-candidate hiring card and choosing who goes; Experience, Work style, Reliability.
5. **Staff load and shifts.** Named front desk staff and eight-hour desk shifts implemented first (2026-10-18); specialties and hospitality followed (2026-10-21), then stamina, fatigue and functional break rooms (2026-10-23). Cross-trained remains.
6. **Morale and quitting,** with a rehiring rule for the bots.

### Phase 1a as shipped (2026-10-12)

`Guest.profile` (Profile.ts), rolled from the booking's id with `hash01` after its party and purpose, which lean it, and stored, so it never changes under a guest. `GUEST_PROFILE.enabled` off: no profiles, and the hotel runs exactly as before (two pinned runs in `test/preferences.test.ts` prove it, one of them a busy hotel where staff meet guests walking out).

- **Chronotype.** Early bird 25 / regular 55 / night owl 20 (business travellers and families lean early, friends late). Facility and outing hours move by -2 / 0 / +2 (a regular's 08:00 is an early bird's 06:00); outings end by 19 / 21 / 23. Sleep hours: early 21-05, regular 23-07, night owl 01-09 (the doc's 02-10 moved to 01-09 so sleep and activity shift by the same two hours). Facility visits that start after midnight count for the day they were planned (a night owl's late swim used to block the next day's).
- **Checkout and the late-checkout policy** (owner decision). Early birds leave at their own hour, 07-10; regulars at 11:00; night owls ask for 13:00, and the Cleaning panel decides: No (they leave at 11:00, 5 points of mood down), Free, or For a fee (30% of the nightly rate). The panel says how many are still to check out today and how many late. Bots keep the default, No.
- **Mobility.** Brisk 0.045 / normal 0.06 / slow 0.09 hours a tile (business brisk, families slow), on every walk a guest takes, their party with them (party spacing follows each walk's pace). Slow walkers mind a full lift 1.5x. Check-in lanes now start once the slowest walker could have arrived, so mixed paces never overlap at the desk. Housekeepers wait at the door until whoever is walking out of a room has stepped out.
- **Sleep sensitivity and rowdiness.** The legacy trait still makes light sleepers (20%) and rowdy guests (15%); the rest are rolled, so heavy / normal / light is 20 / 60 / 20 and quiet / normal / rowdy 20 / 65 / 15. Families are never rowdy.
- **Night noise.** A guest makes noise only while they're in their room and awake (rowdy x2.5, x1.5 more 22-02); facilities only around their hours. Noise counts only while a guest is in their room in their sleep hours, added up night by night (`Guest.nightNoise`: the excess over the threshold times their sensitivity, and the nights it woke them). The review's noise is the average night (1.25 per unit, calibrated so the mean noise penalty matches the old one: 0.150 against 0.157), the mood drifts with it while it lasts, and noise complaints are filed, and judged, only in the complainer's sleep hours. The Noise overlay and the room card show the noise at night ("Night noise:").
- **Bad reviews spread at most once a day** (with profiles on): checkouts now come at several hours, and each batch was another chance to go viral, stacking the 0.7x arrivals penalty.
- **On screen.** A moon (light sleeper) or a note (rowdy) on the guest, at most one; a sleeping guest's room dims, with a "z"; the legend explains them. Click a guest (walking, or at a facility), or "About {name}..." on their room's card, for their card: who they are, night N of M, rhythm with sleep and checkout hours, pace, sleep and noise, what they like, mood, and where they are now; the card follows them between floors, says "Checked out, on their way out" with their review while they walk out, and closes once they've left. Facility cards list who's in, and their hours include the early birds' and night owls'.
- **The bots** now stop adding rooms upstairs once every lift shaft is built and the lifts are 1.5x full (they used to keep building into ever-longer waits, which early checkouts made worse), and then spend on upgrading rooms instead.
- **Balance** (12 seeds x 400 days, mean valuation, profiles off / on): balanced $4.95M / $4.74M, overstaffed $4.36M / $4.59M, understaffed $1.74M / $1.72M, hoarder $1.36M / $1.51M. The order holds. Mean review noise penalty 0.172 / 0.159. (Lower than guest-preferences.md's $5.76M because of the bots' lift limit; with the old bots, early checkouts let them overbuild into lift waits and lost about 18%.)
- **Review:** an adversarial review (6 reviewers, each finding checked by a skeptic) confirmed 21 distinct problems, all fixed: the staff wait and the once-a-day viral limit changed the game with profiles off (now gated, with a second pinned run that would have caught it), quirk icons drawn with profiles off, facility hours ignoring early birds and night owls, walkouts missing from the noise average, noise complaints escalating over daytime noise (now paused while the guest is up), the noise overlay and room card showing daytime noise nobody minds, the guest card's night count (one ahead after midnight), a leaving family's card losing its name, an older guest's trait missing from their card, and eleven test gaps. Three findings were refuted. Every fix and behaviour has a test that fails without it (30 of 30 caught by reverting each).
- **Not done from 1a:** mobility steering room choice (preferences are review-only, so is this).

### Phase 1b as shipped (2026-10-12)

Three switches, `GUEST_FAVORITES`, `LOYALTY` and `MOOD`; with them off (and the rest), the two pinned runs still match the old game exactly.

- **The scale first.** Measured before building: satisfaction barely moved (checkouts p10 47, p90 58), so the doc's mood bands (angry under 35, delighted 75+) never happened, and the return threshold (65) let 10-17 guests a run come back, never a third time. Facility visits now lift a guest's mood (+3, +6 at their favourite) and a favourite that lets them down costs 4, which widens it (p10 49, p90 64); the mood bands sit where guests really are; and coming back is a chance, not a threshold.
- **Favourite facility.** About half of guests have one, rolled with their profile (business travellers lean gym and breakfast, families and getaways the pool). A fan is three times as likely to go, up to twice a day four hours apart, and it counts x1.5 in their review; everyone else is a little less likely (per type, tuned so visits stay where they were: gym 0.45 a stay against 0.47, restaurant 0.83 against 0.79). A favourite the hotel doesn't have (once its stars allow one) or that's full lets a fan down: 4 points of mood, 0.3 off the review a day, two at most, and a review dragged down by it says "the pool". Too far to walk to is counted, not held against them (it's the commonest miss, and depends on where rooms are). With no pool or restaurant, fans go to the beach or out for breakfast, lunch or dinner instead, at most twice a day. The facility card shows fans staying and who was turned back today; the build panel shows how often an unbuilt facility was asked for this week ("asked for 7x this week", once per guest a day, even before the stars allow one).
- **Loyalty.** A guest leaving with satisfaction 52 has no wish to come back; at 68, certainly; delighted guests x1.5 (a hash of their booking). They're back after 5-30 days as the same person (chronotype, pace, sleep, favourite; a new trip and party, and never rowdy with the family), counting stays: returning (2nd), regular (3rd-4th), VIP (5th+). The pool holds 40, losing the least loyal first; VIPs are twice as likely to be the one who comes. A regular asks for their old room first (+4 mood if they get it, no penalty if not: the player can't hold rooms). The loyal forgive more (penalties amplified x0.9 / 0.85 / 0.75), and a regular's or VIP's review and mood count double in the hotel's windows. A regular who leaves more than a point unhappier than last time, or walks out, is lost, with a story on their own thread; a returning guest turned away tries again two days later. Rings: white returning, silver regular, gold VIP (the selected guest's ring moved to light blue). Returns are a toast; a regular's or VIP's is a story too (not an incident: returns no longer use the day's incident budget).
- **Mood.** Delighted 62+, content, irritated under 47, angry under 42 (at checkout about 14 / 82 / 4 / 0.5%). An irritated or angry guest shows a face (in their room it replaces the "z": lying awake); angry guests skip the facilities; delighted ones spend x1.5 at the shop and are likelier to come back. The guest card shows the mood word, their stays and their favourite.
- **Balance** (12 seeds x 400 days, mean valuation, these three off / on): balanced $4.74M / $4.81M, overstaffed $4.59M / $4.58M, understaffed $1.72M / $1.74M, hoarder $1.51M / $1.54M. The order holds. The balanced bot sees about 232 returning guests a run (101 regulars, 17 VIPs).
- **Review:** an adversarial review (5 reviewers, each finding checked by a skeptic) confirmed 13 distinct problems, all fixed: restaurant fans went "out to dinner" at breakfast; fallback outings weren't limited like visits; the build panel's count read as guests; a rowdy guest came back rowdy with the family; a regular who walked out wasn't lost; a regular turned away walked out with a white ring; a second stay's return vanished with the story log open; a refused night owl walked out showing their mood before the refusal; the card's rounded mood could contradict its word; a blocked favourite read as "there isn't one"; full counts showed on every facility of the type; the legend's irritated face didn't match the floor plan's; and the four-hour revisit gap was really five. Seven findings were refuted. 30 of 30 mutations caught.

### Phase 2a as shipped (2026-10-12)

Housekeeping preference and hosted nights, behind two switches, `GUEST_HOUSEKEEPING` and `HOSTED_NIGHTS`. With both off the game is the committed game exactly: the two pinned runs, and 12-seed 400-day runs of all four bots, match seed for seed. Patience, the desk queue and Voice follow as 2b.

- **Housekeeping preference.** Do not disturb 25 / standard 55 / make up daily 20, rolled with the profile (business travellers lean make-up, 30%; getaways leave-alone, 35%). A returning guest keeps theirs; someone first here before preferences gets one now. A hanger on the door says which: red with a white bar for do not disturb, green for make up.
  - **Do not disturb.** A housekeeper goes in only while the whole party is out: from when the last of them has stepped out of the door to when the first steps back in, with time to step in, clean and step out again. They wait in the hallway at the door, never inside, and for at most 15 minutes. Otherwise they come back after other work, or rest and set off in time for a party going out later in the hour. A party out for less than a clean isn't disturbed. In a bot hotel these rooms are cleaned on about 29% of days (standard 38-46%). One left at the end of the shift is reported as left alone, not as a staffing problem. Their review judges the room as everyone's does: the doc's "cost only below 50" is already the rule.
  - **Make up daily.** These rooms are queued on the off days of every-other-day too, and cleaned before the other daily cleans (64-72% of days). Their cleanliness counts 1.6x, measured from a well-kept room (92, a thorough turnover a night on; 70 since the housekeeping rebalance in housekeeping-balance.md, where a night takes 30) rather than from 50. So a missed clean costs them and a kept one barely pays: at 1.6x around 50, every make-up guest would review higher in any decent room. The staffing estimate counts them on the off days.
  - **All daily cleans.** Rooms whose guests are out halfway through the hour go first (the doc's "out at the planned time"). Rowdy guests' rooms get dirty 1.5x faster (from Rowdiness, missed in 1a).
  - **On screen.** The hanger. The room card's "Hanger:" line. The guest card ("Do not disturb (cleaned only while out): cleaned 1 of 2 days"). The cleaning overlay's hollow dot, and the panel line "Daily cleans waiting for guests to go out: N" (this counts parties not out long enough, too).
  - **Mid-hour changes.** After a change to the building, guests now find their way before the staff re-plan, so housekeepers plan around where guests will really be. With the switch off, the old order stands.
- **Hosted nights.** Half of rowdy guests (not all, as the doc had it) have 1-3 friends round on one night of their stay, if they're in and up at 22:00 (so not early birds). The friends walk in from the street, stay in the room till 01:00-02:00 and walk out. That is about one party every three nights in a bot hotel. With every rowdy guest hosting, the mean review noise penalty rose about 40%.
  - While they're in, the host is up and the room is louder: the friends count in the party size. The host stays in, a pulsing ring marks the room, and a click on a friend opens the host's card. There is no hallway noise: sampled at mid-hour, it barely registered.
  - **Complaints.** A neighbour asleep in their room and kept awake, with the host the loudest thing they hear, may complain once that night: light sleepers 60%, normal 25%, heavy 5%, from their booking. Nobody complains twice in a stay, and nobody leaving that hour complains. There is one complaint per party, on a thread of its own in the story log ("Room 1-24 has 2 visitors (since 22:40)" > "Ingrid in Room 1-25 complained about the noise"). It isn't a new story, so the day's incident budget doesn't stop it. About 45% of parties draw one.
  - **"Ask the visitors to leave."** The doc made this an incident action. At two real seconds a game hour, nobody could react in time, so it is a front desk policy in the Staff panel ("ask them to leave", the default, or "let them stay"), plus a button on the room and guest cards for any time the friends are there or on their way up (those still on the way turn round).
    - Asking needs someone at the desk. The friends are out of the room six minutes later. The host loses 10 points of mood and keeps it down for the rest of the night.
    - The complaint is answered: "You asked Room 1-24 to keep it down; the visitors left at 00:40", and the neighbour gets +10.
    - Left alone, the complaint resolves once the friends go. But a neighbour still kept awake two sleep-hours on checks out early: 22-40% of complaints in measured runs, against none with "ask".
    - The bots keep the default, which beats "let them stay" for every bot.
- **Balance** (12 seeds x 400 days, mean valuation, 2a off / on with the default policy):

  | Bot | 2a off | 2a on, default |
  |---|---|---|
  | Balanced | $4.56M | $4.44M |
  | Overstaffed | $4.63M | $4.41M |
  | Understaffed | $1.82M | $1.71M |
  | Hoarder | $1.50M | $1.43M |

  - With 2a on, the order holds and nobody goes bankrupt. With "let them stay": $4.27M / $4.35M / $1.64M / $1.44M.
  - Mean review noise penalty: 0.196 with "ask", 0.226 with "let them stay".
  - The 2a-off baseline was re-measured at c37f7e3. It gives $4.56M for the balanced bot, not the $4.81M recorded above for 1b, which doesn't reproduce.
- **Housekeeping staffing.** A staffing curve showed that 1.0x to 1.6x of the estimated housekeepers all land within about 3% of each other, with 2a off as well as on: understaffing costs dearly, overstaffing buys nothing. So the test that staffing to the workload beats overstaffing was a coin flip even at c37f7e3. It now asserts only that overstaffing buys nothing (within 5%). Making the estimate a real optimum is left as a follow-up. (Done on 2026-10-12, with a strict test again: see housekeeping-balance.md.)
- **Review.** Two adversarial rounds, each reviewer's finding checked by a skeptic.
  - **The first** (5 reviewers) confirmed 12 distinct problems, all fixed:
    - a do-not-disturb room turned down once was never retried that hour;
    - the housekeeper waited inside a do-not-disturb room with the guests;
    - a room whose party was out, but not for long enough, read "all housekeepers busy";
    - a reroute split a visit into two stays, so the simulation lost the visitors still drawn in the room;
    - turning the host's door ended the visit for free and walked the friends out through a wall;
    - the host could lose 10 twice;
    - a guest walking out that hour could still complain;
    - the do-not-disturb notice was swallowed by the "rooms cleaned" toast;
    - a hand ask showed nothing with the story log open;
    - messages said "the visitors" for one;
    - two untested paths (the old settle order with the switch off, visitors re-routed before setting off);
    - an older gap in a re-planned housekeeper's hour.
  - **The second** (3 reviewers, on the fixes) confirmed 5 more, all fixed:
    - a housekeeper waiting for a later party could wait inside the room just cleaned;
    - a clean cut at the bell could be dropped with only a step to spare;
    - a complaint after a hand ask went unanswered;
    - the tick's "leaving" wiring was untested;
    - merging a continued stop into one stay also changed facility crediting in the old game. The merge is now for visitors only. The old double-credit of a visit under way during a rebuild is left as a separate fix.
  - Seven findings were refuted, among them that make-up's 1.6x tracks turnover quality (by design: they mind cleanliness more).
  - 61 of 62 mutations caught; the other is equivalent (a queue filter the planner repeats).

### Phase 2b as shipped (2026-10-12)

Patience with the front desk queue, and Voice with complaint trips, behind two switches, `PATIENCE` and `VOICE` (both need guest profiles). With both off the game is the committed game exactly: a third pinned run in `test/preferences.test.ts` (the 2a game, every other switch on) and 400-day runs of all four bots match ec57afc seed for seed.

- **Patience.** Patient 25 / normal 55 / impatient 20 (business travellers 15 / 50 / 35): waits up to 1h / 18 min / 9 min in line, and minds a full lift x0.6 / x1 / x1.5.
- **The desk queue.** Each seated clerk is a lane. What a lane is doing is read from people's legs: every check-in and complaint at the counter is a stay that names its lane (`deskId:seat`), so lane time carries across hours, saves and reroutes with no separate `state.deskQueue` to keep in step.
  - The hour's arrivals reach the desk spread over the hour in the order they booked, after the slowest walk in from the street (and never ahead of the last hour's last arrival). Each takes a room as before (the party fits, a regular's old room, the price), then the first free clerk, preferring one with a way to the room.
  - Someone whose wait would outlast their patience stands in line exactly that long and walks out, with a toast as they go ("Omar gave up after 18 minutes in line"). They count as turned away, as the party they came as. The room is the next guest's.
  - A wait minds them in proportion to their patience: up to 4 points of mood, after a 3-minute grace.
  - A clerk hired mid-hour takes the head of the line at once. One let go mid-service finishes there and then; their line joins the others' at that desk. A desk with no clerk left: those in line go on without, as before the queue. Nobody is served before the moment of the change: time already spent in line stays a wait.
  - **Check-ins come first.** A guest come down to complain is heard when a clerk is free of them (complaints in the order they got there), so a complaint never makes anyone checking in wait longer. A clerk can sit idle a few minutes for someone already walking in.
  - On screen: the line at the desk, each clerk's in front of them, in the order they'll be served; a clock filling red over anyone past half their patience. The Staff panel's "Front desk today": in line now, checked in (average wait), gave up, complaints, with advice when people give up (another clerk, or another desk once every seat is taken). The guest card: "Waited 24 min in line to check in".
- **Voice.** Vocal 25 / typical 55 / stoic 20.
  - **Who speaks up.** A vocal guest complains once irritated (below 47), a typical one once angry (below 42), a stoic one never. These lines replace the old incident threshold (35) for the night's noise complaint too.
  - **By day, in person.** A guest awake in their room below their line walks down to the desk (at a hashed moment in the first half hour), waits their turn, takes a clerk for a quarter of an hour, and walks back, all in their waking hours. Not on their last day, while they've friends round, while something's already being dealt with, or with nobody at the desk. In person needs the desk queue: with Patience off, complaints are calls only.
  - **Heard.** +5 mood, a toast and a story line naming what's wrong: whatever costs them most (last night's noise, the room's condition, it not being cleaned, something about the room, the lift, a favourite that let them down today), else "their stay". The first such complaint about a cause each day carries advice ("Housekeeping is behind: more housekeepers, or clean every day."). It isn't an incident: it uses none of the day's story budget.
  - **At night, a call.** The noise complaint, and the complaint about a neighbour's visitors (a vocal neighbour 1.6x as likely, a stoic one never). A telephone over the room for an hour.
  - **One complaint a stay,** in person or by phone. A trip down cut short before the counter (no clerk left) doesn't count, and they turn back at once.
  - **Stoic guests** mind 1.15x in their review (vocal and typical 0.9625x: on average the same), their bad review is twice as likely to be the one that spreads, and their mood shows as "?" on their card and no face on the floor plan. The doc's 1.3x cost a hotel about 3% by itself: it fattened the tail of reviews below the line where a bad review spreads (89 a run became 98), each one a 30% dip in arrivals for two days.
  - On screen: a speech bubble over someone on their way down; the guest card's "Complained at the front desk about the state of the room (14:20)" or "Rang the front desk...".
- **Balance** (400 days, mean valuation; balanced 36 seeds, understaffed and hoarder 24, overstaffed 12):

  | Bot | Off | Patience | Voice | Both |
  |---|---|---|---|---|
  | Balanced (36 seeds) | $4.49M | $4.49M (-0.1%) | $4.39M (-2.4%) | $4.44M (-1.3%) |
  | Overstaffed (12) | $4.41M | $4.18M (-5.3%) | $4.37M (-0.8%) | $4.42M (+0.2%) |
  | Understaffed (24) | $1.67M | $1.63M (-2.6%) | $1.71M (+2.5%) | $1.54M (-7.8%) |
  | Hoarder (24) | $1.48M | $1.47M (-0.6%) | $1.49M (+1.1%) | $1.51M (+2.6%) |

  - Differences are paired by seed. The standard error is about 1.7 points for the balanced bot, 3-5 for overstaffed and understaffed, and 1.5 for the hoarder, so only the understaffed bot's -7.8% (about 2 standard errors) stands out. That bot sees 2-3 complaints and about 9 give-ups in 300 days: the gap is its growth path diverging (Voice draws the incident pick even with nobody to pick, so its hotels end up 14 or 33 rooms), not the desk. With both on, the order holds and nobody goes bankrupt. Mean reviews barely move (balanced 6.70 / 6.68).
  - The first sweep, before the review's fixes and with the doc's 1.3x stoic weight, had the balanced bot at -6.1% (36 seeds).
  - In a balanced-bot hotel over 200 days: 7-8% of guests wait to check in (the longest 17-18 minutes), 14-18 give up, 13-24 walk down to complain (about half about the room's condition, a quarter to a half about last night's noise), and about 40 ring at night. The trip down and back takes one to two hours in a big hotel: guests walk about 4 minutes a tile.
- **Review.** Two adversarial rounds, each reviewer's finding checked by a skeptic.
  - **The first** (5 reviewers) confirmed 17 distinct problems, all fixed:
    - the desk wasn't first come, first served: lane time went to whoever was booked first, so a complaint planned the hour before could hold up an arrival who got there first (now: check-ins first, then complaints, each in the order they got there);
    - a clerk hired mid-hour "served" people in the past: they jumped from the line to halfway to their room, and their wait was lost;
    - a reroute while someone was at the counter split the stay in two, so a check-in was counted twice and a complaint heard twice;
    - a complaint trip cut short before the counter used up the guest's one complaint;
    - with Voice on and Patience off, complaints took no clerk's time;
    - any noise at all last night named the complaint "the noise", even in a broken room;
    - a family who booked smaller and gave up counted as a couple;
    - a re-seat could move someone to a clerk at another desk facing the same spot;
    - the line was drawn mirrored against the clerks at a desk facing up or sideways, two desks facing one spot merged their lines, and the back of a long line piled onto one pixel;
    - with the queue off, the card said "checking in at the front desk" where it used to say "arriving";
    - five test gaps (no pinned run with just these two off; the lift multiplier test couldn't fail; alignment check O filtered rather than asserted; one complaint a stay and the stoic visitor rule untested; the cut of a fired clerk's service untested).
  - One finding was refuted (a duplicate, judged not a defect).
  - **The second** (3 reviewers, on the fixes) found the ordering itself sound (in a probe of nearly 5,000 mid-hour hires, firings and rebuilds: no lane served two at once, nobody served out of turn or in the past). It found 9 more, all fixed or settled (6 checked by a skeptic, all confirmed; 3 low ones past the cap fixed without one):
    - someone about to give up was drawn ahead of people who got to the line first;
    - two families of four at the two clerks were drawn half a pixel apart;
    - two desks at right angles facing one spot drew crossing lines;
    - someone asking at the desk, or staff waiting there, could stand on the line;
    - nothing tested the line's layout (test/render.test.ts now drives the real renderer);
    - four assertions in the new tests couldn't fail;
    - the legend showed the complaint bubble with Patience off;
    - a save from before 2b had no "last night" for the noise (now: their average night);
    - a clerk let go mid-hour can leave people in the merged line waiting past their patience. Left as it is: patience is judged as they join the line. It happened to 5 of 1,231 check-ins in a probe of constant mid-hour changes, and never in bot runs.
  - 73 of 74 mutations caught. The other is equivalent: the turn a complaint trip waits for after a reroute, which the re-seat that always follows recomputes.
- **Not done from 2b:**
  - A complaint in person isn't an incident (no grace period, nothing escalates), and the night's calls are as before.
  - The Staff panel's check-in capacity doesn't count the clerks' time spent on complaints.
  - A concierge reading stoic guests waits for Specialty (phase 5).

### Phase 3a as shipped (2026-10-14)

Spending style, behind one switch, `SPENDING` (it needs guest profiles). With it off the game is the committed game exactly: a fourth pinned run in `test/preferences.test.ts` (160 days, long enough for the balanced bot's restaurant) and 400-day runs of all four bots match ca7ad40 seed for seed. Spotlight guests and event-goers follow as 3b.

- **Who spends how.** A big spender (the legacy trait, 20%, drawn from the shared random stream as ever) splurges; of everyone else, 3 in 8 are thrifty (30% of guests), hashed from the booking; the rest spend as before. No star lean: the doc's 5 more splurgers a star above 2 was worth +19% to +68% valuation on its own. So every splurger is a big spender, and every rule keyed to that trait (outings, liking deluxe rooms) stays right. A returning guest spends as they did; one first here before 3a gets a roll now. A thrifty guest is never a fan of the shop or restaurant, not even one remembered from before 3a.
- **Budget and price.** Thrifty guests have 0.7x to spend, and go only half as far over a fair price: at most 1.4x, against 1.8x for most and 2.2x for big spenders. The same random draws, only scaled: 3a adds no draws.
- **A big spender's room.** Of the rooms they'd take at all, the best that suits them, at no more than their price tolerance over the cheapest that would do:
  - first a room with no beds they'd pay for and not use (a couple never takes the family room a family needs, nor twin beds);
  - then the best type, then the highest floor, then the cheaper.
  - Uncapped, half of them took suites and the cash-limited bots gained up to 55%.
  - A regular still asks for their old room first; at the desk the first in line gets the suite.
  - Everyone else takes the cheapest room they'll pay for, as ever.
- **Money on site.** The restaurant now charges: $12 a table for one or two (+30% a head beyond, x the restaurant's level revenue), so it roughly pays for itself. The shop as before. Big spenders pay twice as much (three times at the shop when delighted); thrifty guests nothing. Each sale is rounded to the dollar and goes at once to cash, the guest's tally and the hotel's takings.
  - **Takings count as revenue** (`SPENDING.onSiteIsRevenue`): in the Finance panel, in valuation (30 days' revenue x 6) and in "A Good Month", as room bills do. Shop sales used to be cash only, an inconsistency 3a would have grown. Kept as cash only, the cash-limited bots read about 3-7 points lower (the design panel's estimate). Set it false to measure the old way.
- **Thrifty guests.**
  - **No shop or restaurant:** in an hour their pick is one of those, they stay in. The other facilities' rolls are untouched. Letting them take the gym or pool instead had the cash-limited bots gain up to 9%, and failed the staffing gate on seeds 6-11.
  - **Dinner in town:** in their evening (18:00-20:00 for a regular, two hours earlier for an early bird, two later for a night owl), half the time, out to the street, an hour or two in town, back in their room by 22:00 (shifted alike). Once a day; not on their last day, nor the night their friends come round. Counted on their card once they're out. No mood credit, as with the 1b outings.
- **Reviews.** A thrifty guest minds being overcharged 1.5x as much (on what an overpriced room falls short by; priced under fair, as anyone). Amenities count 0.8x for thrifty guests and 1.1x for big spenders (the amenity penalty alike); big spenders mind tired decor 1.1x. The doc's 0.5x and 1.2-1.3x averaged about 1 but spread reviews wider: about a quarter more fell under the line where a bad review spreads, the 2b stoic lesson again. The review stores the price fairness as the guest felt it, so the story names the cause they felt. The overcharge weight is not a lever against overpricing: a thrifty guest past their tolerance doesn't book at all.
- **On screen.**
  - A pale green "$" over big spenders (after the moon and the note; they never clash, as all three come from the one trait roll), and in the legend.
  - The guest card: "Big spender: spent $84 here this stay (restaurant $60, shop $24)" and "Notices the amenities, and tired decor"; "Watches the pennies: no shop, eats in town (out to dinner 2 nights)" and "Minds a high price more than the frills"; anyone else "Spent $26 here this stay". A leaving guest's card: "Spent $84 here". The room card tags "big spender" or "thrifty".
  - The facility card: "Spend/visit: $12 a table for one or two (big spenders $24; thrifty guests eat out)", and the shop's alike.
  - The Finance panel: "Revenue, last 30 days: $32,816 (rooms $30,727, on site $2,089)", then "On site: restaurant $X, shop $Y · 44% from big spenders".
  - The story: "Malik ran up a $210 restaurant tab." A big tab for the restaurant's level, the day's first only; not an incident.
- **Balance** (400 days, mean valuation, paired by seed; balanced 36 seeds, the others 24):

  | Bot | 3a off | 3a on |
  |---|---|---|
  | Balanced (36 seeds) | $4.35M | $4.20M (-3.4%) |
  | Overstaffed (24) | $3.06M | $3.15M (+3.2%) |
  | Understaffed (24) | $2.69M | $2.76M (+2.6%) |
  | Hoarder (24) | $1.38M | $1.38M (+0.4%) |

  - Standard errors of the paired differences: 1.9 / 4.2 / 3.8 / 2.4 points, so only the balanced bot's cost is clearly real. The order holds and nobody goes bankrupt. The 3a-off figures are ca7ad40's: the housekeeping rebalance there moved the bots (overstaffed $4.41M at 2b, $3.06M now).
  - The staffing gate (housekeeping.test.ts) holds in every six-seed block: balanced beats understaffed by 1.53-1.73x (needs 1.5) and overstaffed by 1.23-1.47x (needs 1.15).
  - First sweep (the doc's review weights, thrifty guests taking the gym or pool instead): -5.9% / +2.1% / -5.3% / +3.7%, with the staffing gate failing on seeds 6-11.
  - In a balanced-bot hotel (4 seeds x 400 days): check-ins are 28% big spenders, 52% standard, 19% thrifty (thrifty guests are 30% of arrivals, but turned away on price more). Big spenders have 69% of suite stays (a suite is 10% of stays either way), thrifty guests none. 0.59 dinners in town per thrifty stay. On-site takings are 4.2% of revenue. A big tab makes the story on about one day in nine with a restaurant. Mean review 7.54 -> 7.65; reviews under 3.0: 0.86% -> 0.87%.

- **Review.** Two adversarial rounds, each reviewer's finding checked by a skeptic.
  - **The first** (5 reviewers) confirmed 12 distinct problems, all fixed or written up:
    - the review weights fattened the tail of bad reviews (softened);
    - the staffing gate passed only on its own seeds (the skip variant and the softer weights pass every six-seed block);
    - a couple took a twin junior suite as a snug fit;
    - the dinner skip for a hosting night also caught early birds, and applied with hosted nights off;
    - a dinner was counted when planned, not when the guest got out;
    - the tab story claimed the day's biggest but told the first;
    - the restaurant card's "per cover" was a table's price;
    - the Finance panel showed negative room revenue on the first day, and misread with takings left out of revenue;
    - test gaps (the shop card, levels, the 30-day baseline, the "$" drawing, the amenity penalty weight, the purpose in the dinner chance);
    - and the thrifty overcharge weight is no counter to overpricing (noted above).
  - Five findings were refuted, among them that thrifty guests' dinners rarely happen in big hotels.
  - Four lower-severity findings were fixed without a skeptic: an older save's guest showing no spending, a stray doc comment, a false "staff jump" in alignment check B when the hour boundary falls on a lift ride, and the review weights showing nowhere a player reads (now on the card).
  - **The second** (3 reviewers, on the fixes) confirmed 8 more, all fixed, and 2 more fixed without a skeptic; none refuted:
    - the shop and restaurant lines quoted a party of one or two as if it were any table;
    - on the first day the Finance panel showed $0 for the month while the shop's takings were already revenue;
    - an older save's big spender showed no "what they mind" line;
    - with the switch off, the separate-beds advice read "most book" (now as before: the off game matches ca7ad40 to the word);
    - alignment check B's lift exception was broader than the one ride it's for (narrowed; it never fires in practice);
    - test gaps: the skip itself, a returning guest who isn't thrifty, the thrifty-visit gate, a stale test title.
  - 64 of 64 mutations caught (every rule above broken in turn).
- **Not done from 3a:**
  - The doc's "Who stays" table and the room card's recent stays (to read "my price chooses who comes" at a glance).
  - Prices by meal at the restaurant, and a kitchen cost.
  - The bots price every room at fair, so they can't use the new levers (price suites near deluxe to catch big spenders; price standard rooms up to turn thrifty guests away).


### Phase 3b as shipped (2026-10-16)

Spotlight guests, behind one switch, `SPOTLIGHT` (it needs guest profiles). With it off the game is the committed game exactly: a fifth pinned run in `test/preferences.test.ts` (160 days at three stars, plus the busy overstaffed run) and 400-day runs of all four bots match ae09432 seed for seed. Event-goers, the rest of phase 3, follow as 3c.

- **Who and when.**
  - On Monday at 09:00 the week is rolled from a hash of the week and the latest booking, never the shared random stream: at most one a week, from three stars and with a suite to put them in, one at a time.
  - The chance rises with the stars: one week in twenty at 3 stars, ten at 4, three at 5. A famous guest picks a grand hotel.
    - The same chance at every star helped the under-staffed hotel most (+5%, wearing the staffing gate's margin down): spotlight money and write-ups lift a small hotel more. See Balance.
  - Half are travel writers, half celebrities. They walk in Wednesday to Friday at 15:00-17:00, for two nights.
  - Announced at 09:00 a day or two ahead, as a toast and its own story thread ("A travel writer arrives Thursday at about 15:00 and wants a suite. Room 157 is held for them."), with a reminder the day before. Not an incident: no part of the day's story budget, and the thread is kept in the log while it runs.
  - Dropped quietly if the hotel has fallen below three stars, or has no suite, by the announcement.
- **The suite held.** A standing policy on the Staff panel, Hold a suite (the default) or Don't hold one.
  - The best suite their party fits that will be free by then is held: vacant; being cleaned (by the housekeepers' queue and shift hours, never with none); renovating but done in time; or with a guest who leaves before the day. A writer gets the freshest, a celebrity the highest.
  - Nobody who'd still be in it on the day can book it, at the desk or by a mid-stay move. A renovation or a refit that would run past the arrival is refused (the Furnish panel offers to refit after them).
  - The hold stays put while the suite will be ready for them by the last check-in (a better one coming free later doesn't take it), and moves, with a story line, if it won't. A celebrity's moves up to a higher suite that's ready.
  - On the suite's card: "Held: for the travel writer (Thu ~15:00)", Let the hold go, and on another suite, Hold for the travel writer. The door has a lilac tag.
- **Arriving.** Their room is decided at the hour boundary before they walk in, first in line; they never give up in the queue (no patience clock over them).
  - The held suite. Still being cleaned: they wait for it, if it'll be ready by the last check-in, unless another free suite suits them as well. With no hold, the best suite free.
  - No suite free: they wait while one will be ready by the last check-in. At the last check-in hour, the best room free, or none ("found no room free and went elsewhere"). With nobody at the desk, they wait too.
  - The story says when the held suite wasn't ready. No draws: who they are comes from hashes of the plan, a different person each game.
- **The travel writer.** Alone, on a getaway: regular hours, even-handed, vocal, standard housekeeping; a notebook over them.
  - Tries every facility the hotel has, in turn, once each, at the first hour it's open to them: however cross, however far (the walk limit doesn't apply). Full: they try again the next hour.
  - Judges the hotel a star up: a 3-star hotel as a 4 (its expectation, and the amenities a 4 must have: basic ones are a fault). A 5-star hotel by their own standard (1.9). They take the amenities of that class for granted (no bonus for them), so the writer tells hotels apart.
  - Their review counts five times over in the hotel's rolling windows.
  - 8.5 or more: a write-up, bookings +20% for a day (the doc's 48 hours moved the staffing gate past the game's own noise). 4 or less: it spreads as a bad review does, always, and is the day's one; on a day one already has, it keeps that one going, no deeper.
  - The write-up names what they loved and minded most, from the review's own parts, the room's faults weighed as hard as they minded them; the price is never a reason to love it ("loved the pool; minded slow lifts").
  - The bots' building looks past a write-up, as it looks past the season.
- **The celebrity.** A couple, big spenders, patient, behind a do-not-disturb sign; a pink star over them.
  - In a top-floor suite they pay double; anywhere else, the price. Moved down off the top floor by a breakdown, they pay the price from then (the nights before stay double, walking out too).
  - Walk-ins +10% from when they check in to the end of the day.
  - Their checkout story says what they paid.
- **On screen.**
  - The top bar: "✎ Travel writer due Thu ~15:00 (in 1d 6h)", then "staying in 157"; a write-up or a bad review spreading, with its hours left; a celebrity's pull.
  - Their card: who they are and what their stay means ("Travel writer: judges the hotel as a 4-star one...; their review counts 5 times over", what they've still to try; "Celebrity: paying double for a top-floor suite").
  - The room card tags them; the leaving card says who they were. Legend entries for both marks and the held tag.
- **Balance** (400 days, mean valuation, paired by seed; balanced, overstaffed and understaffed 96 seeds, the hoarder 48):

  | Bot | 3b off | 3b on | Writers a run (write-ups) | Celebrities a run |
  |---|---|---|---|---|
  | Balanced | $4.17M | $4.23M (+1.5% ± 1.4) | 5.6 (62%) | 5.9 |
  | Overstaffed | $3.28M | $3.30M (+0.5% ± 2.5) | 2.9 (93%) | 3.4 |
  | Understaffed | $2.71M | $2.77M (+2.2% ± 2.0) | 3.3 (88%) | 3.4 |
  | Hoarder | $1.44M | $1.41M (-2.0% ± 2.3) | 1.3 (95%) | 1.2 |

  - Nobody goes bankrupt; the order holds. A celebrity pays about $1,400-1,900 a stay. Of about 1,200 writers, one panned a hotel (a hoarder's).
  - **The staffing gate** (housekeeping.test.ts) passes: on its six seeds (0-5) balanced beats understaffed by 1.78x and overstaffed by 1.46x. Over all 96 seeds the medians are 1.60x and 1.39x (1.61x and 1.34x off).
  - **The gate's noise.** Re-rolling the random stream alone (no change to the game: one extra draw at the start) fails a six-seed block one time in five or so (5 and 9 of 32; the game itself 6, 3b 5). So six-seed blocks can't judge a change; runs of 24 seeds can (no failure for the game or either re-roll; their worst 1.52x). With 3b one run of 24 in four falls just short (seeds 48-71, 1.47x: a balanced dip and an understaffed rise together).
  - **The gate now takes 24 seeds** (0-23; added after 3b shipped): 1.69x and 1.47x with 3b, 1.62x and 1.38x without. About five minutes instead of one and a half.
  - **What was tried.**
    - The doc's one in two weeks with 48-hour write-ups: +0.4 / +11.1 / +8.4 / +14.5%, and the gate failing.
    - 24-hour write-ups, then rarer rolls: closer, but the same chance at every star left the understaffed bot +5.0% ± 2.0 over 96 seeds.
    - Taking the write-up, the review weight or the celebrity's money away left it +4-5% each. Announced and held but never arriving: -0.4%. Not one mechanism: the guest's stay and its money in a small hotel.
    - A chance rising with stars took it to +1-3%, with the gate like the re-rolls'.
- **Review.** Eight adversarial rounds, each finding checked by two skeptics: one reading the code to refute it, one writing a probe to reproduce it.
  - **The first** (six reviewers and a completeness critic) confirmed 38 findings, many the same problem seen from several sides, about twenty distinct, all fixed. None refuted. Among them:
    - on the arrival day the hold could move to a better suite vacated that morning and still dirty, and the ready one got booked;
    - the guest didn't wait for a held suite being cleaned, and waited for suites ready only by midnight;
    - a suite held for a couple could sleep one;
    - the announced time was an hour before they could appear;
    - the write-up named faults as anyone would, not as the writer felt them;
    - a pan could stack on a bad review already spreading that day;
    - the story chain could be pruned while it ran;
    - a refit could close the held suite past the arrival;
    - a save's spotlight guest wasn't ordinary with the switch off;
    - check W didn't check the hold or the tour;
    - fourteen test gaps.
  - **The second** (five reviewers and a critic) confirmed 14 (eight distinct), all fixed; two refuted. The worst: the first round's "wait for the held suite" could never happen in a real tick, because the hourly hold re-pick dropped the suite first. Also the celebrity's rate after a move, the Furnish panel, the patience clock, and every game's guest being the same person on a given day.
  - **The third** (three reviewers) confirmed nine, all fixed: a celebrity's move up gave away a ready suite for one still dirty; the cleaning estimate ignored the housekeepers' queue (and none at all); the double nights after a move were billed and told as an average.
  - **The fourth** (two reviewers) confirmed four, all fixed: the estimate of when a suite being cleaned would be ready shared the work as one pool among the housekeepers (they take a room each), ignored walks and the day's checkouts still to come and counted rooms nobody could reach; and a refit booked on the held suite started as soon as the room was empty, though the Furnish panel said it would wait.
  - **The fifth** (two reviewers) confirmed four, all fixed: the estimate put later checkouts ahead of a suite a free housekeeper would start first, and charged a walk to a room a housekeeper was already in. It is now a time-ordered schedule, as the housekeepers work it out hour by hour; its prototype, measured against the real tick, all but ended the false "won't be ready" calls without adding waits in vain. The Furnish panel's booking button for the held suite said "once there's $X".
  - **The sixth** (two reviewers) confirmed five, all fixed: the estimate charged every turnover the whole day's walking (two and a half walks from base, three to five times a real walk between rooms), which near the shift's end turned "ready tonight" into "tomorrow" (a suite lost in about one visit in a hundred in busy hotels, and false "won't be ready" stories); a housekeeper free off shift took a job before the morning's checkouts were queued; a suite with a refit booked (and not held) counted as free though the refit would start once it was empty; an occupied suite counted as free whatever its turnover after the guest.
  - **The seventh** (two reviewers) confirmed four, all fixed: the sixth round's refit rule was too blunt (a suite with a refit booked couldn't be held, though holding it is what makes the refit wait: now only waiting for a suite not held leaves such a suite out), and a housekeeper doing a daily clean in an occupied suite was counted as already turning it over. It measured the sixth round's changes as neutral to better for the guest (no waits in vain before or after). A fifth finding was a design question, not a defect (see below).
  - **The eighth** (two reviewers, on the seventh's two fixes) confirmed one, fixed: when the hold left a suite with a refit booked in the middle of the hour ("Don't hold one", or a celebrity's hold moving up), the refit had already been passed over that hour, and a walk-in could take the suite first. None refuted, and nothing else found: the rounds were down to one low-severity edge.
  - 158 of 158 mutations caught (every rule above broken in turn). Three others were equivalent: a reminder guard that could never matter (removed), a switch check made twice, and the no-housekeepers guard (without it nothing is ever waiting, so never ready all the same).
- **Not done from 3b:**
  - The held suite can be let to a guest who leaves the day before the arrival (the hotel earns that night). In a badly understaffed hotel its turnover then sometimes isn't done in time and the spotlight guest gets a lesser room: at full staffing never, at 60% of the housekeepers needed about one visit in 200, at 40% about one in 20 (the seventh round's measurement). Closing the held suite to every booking while they're announced would end it, at the cost of up to a suite-night a visit.
  - The doc's other prep (daily housekeeping, pausing renovations nearby, a quiet floor) works only through the hotel-wide settings: nothing ties it to the spotlight guest's room, or points the player to it.
  - A concierge who spots spotlight guests (open question 6 is settled: always announced).
  - The bots don't prepare for spotlight guests.

### Phase 3c: event visitors (2026-10-17)

- The existing calendar supplies the event name and an absolute checkout day, including New Year across the year boundary. About one in twenty existing bookings is an event visit; total demand and party generation are unchanged. Their nightly budget is 20% higher and they stay through the event's final night.
- Fresh visitors lean toward late nights and rowdiness; families remain non-rowdy. Returning visitors retain their personal profile. Event trips take priority over facilities, leave 17:00-20:00 and return through a street entrance by 01:00, without shifting the shared random stream.
- Lavender figures, the legend, a named-event line on the guest card, and one story entry per arrival day explain the behavior. Saves retain the event and the checkout date.
- The initial 30% arrival mix overfilled the hotel with long stays and disproportionately helped understaffed strategies. The default is 5%, pending broader player feedback. The housekeeping estimate recognizes event stays and the approaching checkout rush. The existing 1.5x/1.15x staffing gates remain unchanged.
- With EVENT_GUESTS off, the committed 60-day balanced run is pinned exactly. Tests cover calendar boundaries, generation, budgets, overnight trips, profile biases, save round trips, and the workload estimate.

### Reliability and tooling (2026-10-17)

Player actions save immediately, including paused edits. Ticks and page hiding/exiting also save, with the fractional hour, pause and speed restored on reload. Storage failures have a visible warning and retry. Discarding a save prevents the exit handler from restoring it. Supplied storage is now used consistently by the controller and save manager.

Vite 8, Vitest 5, Happy DOM 21 and current tsx replace the vulnerable toolchain; npm audit reports no known vulnerabilities. The project uses Node 22.12+ (22.x), 24.x or 26+. Long synchronous balance tests have explicit timeouts under Vitest 5. The README provides setup, verification, save behavior and the current roadmap.

### Phase 4: named staff hiring (2026-10-17)

- Housekeeping and maintenance have persistent serial IDs, names, hire dates, agreed wages, experience, work style and reliability. Three deterministic candidates are offered per role; hiring consumes a slot and replaces it, including through a reload. The player can choose a specific employee to dismiss. Count shortcuts and simulation strategies use the same candidates and dismissal rules.
- Experience increases only for actual cleaning and repair stays, at 80 and 400 work hours. Work rates change real itinerary durations; each leg stores its rate so a promotion or a mid-hour replan cannot change past work. Walks and rest do not earn experience. Promotions automatically raise wages in this phase; negotiated raises and quitting belong to morale in phase 6.
- Speedy and meticulous workers trade time for cleanliness or repair condition. The employee finishing a clean determines its result. Meticulous cleaners report damage; it is visible on the room card and prioritized for maintenance once vacant. Room cards retain the last cleaner's name and style.
- Reliability uses hashes of employee ID and day, independent of the shared random stream. Late employees really arrive later; absent employees stay off site and are unpaid. Attendance and promotions produce story entries and notifications. Earned wages survive dismissal and are settled the following day. Cash reserves budget for the full roster rather than treating today's absence as permanent savings.
- The staff panel shows candidates, the current team, activity, rates, wages and attendance. Click a name or a worker on the floor for their card. Uniform chevrons show experience. Staffing and held-suite readiness estimates account for individual rates and attendance.
- Save version 21 gives older workers neutral profiles without changing their IDs, wages, current positions or saved plans. Hire serials never get reused. Existing neutral staff begin gaining normal veteran performance when promoted.
- At phase 4 completion, front desk staff remained a count. Its named roster and shift implementation is described below. Specialties, fatigue, compulsory breaks, morale, negotiated raises and quitting remain later work.
- Balance tuning reduced the draft rookie discount from 20% to 10% and the flaky discount from 10% to 5%. In the initial 24-seed, 400-day run, the draft discounts let overstaffing beat the workload-sized team (median $4.88M versus $4.65M). Both staffing gates remain unchanged; cheaper hires must still carry a real performance or attendance tradeoff.
- Focused tests cover hiring and dismissal, candidate consumption, migrations, individual work credit, mid-hour changes, finisher quality, repairs, promotions, deterministic attendance, earned wages, rendering and interface flows. With both new feature switches off, the committed balanced simulation remains pinned exactly.

### Phase 5 slice: named front desk clerks and shifts (2026-10-18)

- The owner requested shifts as part of this milestone. Early is 06:00–14:00, late 14:00–22:00, and night 22:00–06:00. A new hotel has three neutral skilled clerks, one per shift. The front desk count is total employees, rather than simultaneous seats. Each reachable desk still seats two clerks. The panel shows scheduled coverage for every shift and how many are actually at the counter now.
- Clerks share the persistent identity, candidate and dismissal system. A shortlist describes experience, reliability and the selected shift's wage. The player chooses a hiring shift or changes an existing clerk's shift while off duty. Reassignment retains the rest interval until at least 24 hours after the previous shift began, preventing one person covering consecutive shifts. The + shortcut fills the least-covered shift; − removes a surplus-shift clerk first, then the lowest value employee.
- Check-ins take 25 / 20 / 16 minutes for rookie / skilled / veteran clerks. Complaints take 15 minutes. Only actual service grows experience, attributed to the employee stored on the guest's service leg; idle counter time and commuting do not. A service already underway keeps its duration through promotion. Hospitality and specialties remain future work; work style does not alter front desk service.
- The queue books a physical desk seat within a particular clerk's duty window. A check-in must fit before the shift ends; otherwise the next clerk serves it. Late clerks really walk in after their due time, and absences leave a gap. Attendance after midnight belongs to the day the night shift started. Waiting guests are rescheduled after staffing changes, without bypassing the counter during a coverage gap. Night visitor requests and checkout delays use actual coverage.
- A new eight-hour contract starts at 55% of the former $70 full-day front desk wage ($38.50), with experience and reliability factors and a 25% night premium. Shift wages accrue proportionally over eight paid hours. Attendance gaps are unpaid; night pay is apportioned to the calendar days on either side of midnight. Earned wages survive dismissal, and repeated payroll recording cannot pay an hour twice. The bots budget and hire one crew per shift.
- Save version 22 converts every former 24-hour position into three neutral, dependable named clerks. Their eight-hour wages total the former $70 ($23.33 / $23.33 / $23.34), keeping existing coverage and wage budgets. Housekeeping and maintenance identities, current positions, saved plans and the fractional clock are preserved. New hires use current contract rates.
- Blue staff figures follow their commute and counter itinerary and open their individual card on a click. The team and inspector show shift, check-in time, wages, service experience, attendance and current activity. Paused hiring, shift changes and partial walks survive reloads. The `FRONT_DESK_STAFF` switch gates this slice alongside `STAFF_PERSONALITIES`.
- Verification covers handovers, missing shifts, overnight attendance, late commutes, check-in durations, service experience and promotion, prorated pay and dismissal, migration and reloads, named counter rendering, and the hiring and assignment controls. The existing 24-seed, 400-day staffing gate retains its 1.5x / 1.15x assertions.
