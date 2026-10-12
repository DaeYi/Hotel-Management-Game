# Design: Guest Preferences and Purpose of Stay

Date: 2026-10-11
Status: SHIPPED (v1: purpose of stay, room preferences in reviews, "Good for" in the inspector)
Repo: DaeYi/Hotel-Management-Game
Follows: rooms-rethink.md (phase 2: free placement and parties), guest-staff-personalities.md (Purpose of stay, the display budget)

## Request

> Ok what's next? → "Guest preferences (Recommended)": purpose of stay plus room preferences (desk, tub, twin vs double, sofa bed) in reviews; the inspector says who a room suits. Makes the editor's choices matter.

The free editor (rooms-rethink phase 2) lets the player choose a desk or an armchair, a tub or a shower, a king or a queen, a sofa or a sofa bed, art or none. Before this change none of those choices mattered beyond cost, unlocks and the grade. This slice gives them a reason.

## Decisions

1. **Preferences are review-only** (rooms-rethink open question 14, the recommended answer). They never decide which room a guest books; `matchGuestToRoom` is unchanged.
2. **Purpose follows the party, not the other way round.** The design doc rolls purpose first and party from it; the shipped party mix is calibrated (rooms-rethink phase 2 balance), and `'business'` is already a party kind. So a business party is on business, couples, friends and families are sightseeing or on a getaway, and solo travellers are mostly on business:

   | Party | Business | Sightseeing | Getaway |
   |---|---|---|---|
   | business | 1 | | |
   | solo | 0.7 | 0.2 | 0.1 |
   | couple | | 0.5 | 0.5 |
   | friends | | 0.7 | 0.3 |
   | family | | 0.7 | 0.3 |

   Through the party mix this gives about 45% business, 33% sightseeing, 23% getaway on weekdays and 15 / 51 / 34 at weekends, which is the design doc's 45/35/20 and 15/50/35.
3. **Rolled from the booking's id** (`hash01(`${id}#purpose`)`) from the party they came as, right after the party roll; a party that books smaller keeps it (parents who take a double are still sightseeing). The shared random stream never moves. Returning guests get a new id, so they re-roll (guest-staff-personalities open question 3, left at the default).
4. **Mostly likes.** Desks, tubs and sofa beds are rare in the presets (the starter Standard Queen has none), so "business wants a desk, −0.3 without one" would penalise every early hotel. Rules are likes, with one dislike: a couple given separate beds.
5. **Figure colour is purpose** (guest-staff-personalities open question 1, the display budget's proposal): slate for business, yellow for sightseeing, rose for a getaway (apart in brightness as well as hue, for colour-blind players), white for a guest from before purposes. The legend lists them, and adds "Other" (white) while any guest has no purpose ("Guest" with purposes off). The trait colours were never explained in the legend, and red and pink were nearly the same; the trait now shows in the room inspector ("light sleeper", "rowdy", "big spender").
6. **Switches:** `GUEST_PURPOSES.enabled` and `ROOM_PREFERENCES.enabled`. With both off, a run is what it was before.

## What purpose changes

- **Going out** (`GUEST_PURPOSES.outing`, on top of `GUEST_OUTINGS.leaveChance` and the trait multiplier): business ×1.3 for 6-10 hours ("out at a meeting"), sightseeing ×1.15 for 3-8 hours ("out sightseeing"), a getaway ×0.4 for 2-4 hours ("out for a stroll"). Everyone is still back by 21:00. The inspector says where and until when: "out at a meeting, back about 18:00".
- **Facilities** (`GUEST_PURPOSES.facility`, on the hourly visit chance, capped at 1): business travellers use the gym (×1.6) and the restaurant (×1.3) and rarely the pool (×0.3); sightseers the shop (×1.4); a getaway the pool (×1.8) and the restaurant (×1.2). The facility inspector says "Popular with: business travellers".
- **Who's staying:** "Occupied: a couple on a getaway (light sleeper), out for a stroll, back about 13:00".

## Room preferences

`roomFeatures(profile)` reads a room's furniture: a desk (not an armchair), a bathtub, a king bed, a sofa bed, a sofa (not a sofa bed), artwork, a deluxe-or-better grade, and separate beds (it sleeps two or more but has no bed two can share).

`ROOM_PREFERENCES.rules` (who is a purpose, a party kind or a trait):

| Who | Feature | Weight |
|---|---|---|
| business | desk | +0.4 |
| couple | king bed | +0.3 |
| couple | separate beds | −0.6 |
| family | bathtub | +0.3 |
| family | sofa bed | +0.2 |
| friends | sofa | +0.3 |
| getaway | bathtub | +0.3 |
| getaway | king bed | +0.2 |
| getaway | artwork | +0.2 |
| big spender | deluxe or better | +0.3 |

A guest's **room fit** is the sum of the rules about them that the room meets, capped at ±1. It is:

- **a review term**, added like the facility bonus (not amplified by star expectations), with no extra draw from the shared random stream;
- **in the mood the stay drifts toward** (×10, the same scale as condition and cleanliness), so the review and the guest's satisfaction agree;
- **a review cause**: a review dragged down by separate beds says so ("bad review (separate beds)");
- **on screen**: the room inspector says what the guest staying likes and dislikes ("Likes the king bed, the bathtub and the artwork."), and under "Fits ..." who the room suits: "Good for business travellers, couples, getaways, big spenders", or "Couples won't like separate beds". "Good for" is what the review would say for a typical booking of each kind (a getaway is a couple), so a twin with a bathtub isn't "good for getaways"; kinds of guest that can't book with a switch off aren't listed. The Furnish panel shows the same lines live as you edit, so swapping the armchair for a desk shows "Good for business travellers" at once;
- **a story**, once a day, when guests check out unhappy with something: "2 guests didn't like separate beds (rooms 106, 138). Couples want to share a bed, but they book the cheapest free room that sleeps two: price your twins above your doubles, or keep them for friends."

### Returning guests come back

Before this change a guest's mood could never reach the return threshold (65): the drift target topped out at 61.5. Room fit lifts it, so guests who loved their room can now come back ("Sam is back for another stay!", or "..., with the family!": who they bring is rolled afresh, so the message names the guest, not the party). This revives the return mechanic from the story-generator milestone; returning guests replace fresh arrivals rather than adding to them.

## Not in this slice

- Chronotype, favourite facility, loyalty, mobility, the nightly noise tally, the stay ledger, staff identity (guest-staff-personalities phase 1).
- Purpose changing stay length or price tolerance (both come from the shared random stream; a real balance change).
- Per-purpose review weights (elevator ×2 for business, decor ×1.5 for a getaway): they don't average to one.
- A click-a-guest inspector: the room inspector carries the guest for now.
- The "honeymoon" story label and event-goers.

## Balance

12 seeds x 400 days, mean valuation (median in brackets):

| Bot | Both off | Purpose only | Both on |
|---|---|---|---|
| Balanced | $5.00M ($5.18M) | $5.20M ($5.09M) | $5.76M ($5.91M) |
| Overstaffed | $4.09M | | $4.46M |
| Understaffed | $1.62M | | $1.73M |
| Hoarder | $1.20M | | $1.30M |

- Purpose alone is within the noise. Preferences add about 15% for the balanced bot: it builds Deluxe Kings, which come with a desk and a king bed, so 56% of its guests like something (mean room fit +0.25) and 3% dislike something (couples put in twins). The strategy order holds: balanced > overstaffed > understaffed > hoarder.
- About 10 guests return per 400-day run (none did before).

## Review

An adversarial review (5 reviewers, each finding checked by a skeptic) confirmed 11 distinct problems, all fixed above: the separate-beds advice described booking wrongly (couples take the cheapest free room that sleeps two, twin or not); "Good for getaways" could contradict the review (a twin with a tub); with purposes off the legend, "Popular with" and "Good for getaways" still showed purposes, and guests without one had no legend entry; a returning guest was announced as a party that never stayed ("The Mensah family is back"); business grey and getaway rose were hard to tell apart under protanopia; a suite was called "a deluxe room"; and six gaps in the tests (the switched-off run now pins the numbers from before this change; the review's single draw; the cap; purpose in the inspector; walkouts' room fit; walk-ins' colour). Seven findings were refuted. Each fix has a test that fails without it (checked by reverting each, 16 of 16 caught).

## Tests

`test/preferences.test.ts`: the purpose roll (follows the party; the weekday and weekend mix; off means none; the shared random stream doesn't move; kept through a smaller-party reroll), outings and facilities by purpose (and the cap at 1), room features from furniture (an armchair isn't a desk, a sofa bed isn't a sofa), room fit (likes, the one dislike, the cap, off means nothing), the review (+fit exactly, no extra draw), the mood drift (+4 for +0.4), "Good for" per preset, the dislike story (once a day, where and why), walkers' colours, and runs with everything off. `test/ui.test.tsx`: "Good for" live in the editor after swapping the armchair for a desk, the inspector's guest line and likes, the twin-room warning, the gym's "Popular with", the legend.
