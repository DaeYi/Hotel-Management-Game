/** Individual staff: phase 4. Later phases add fatigue and morale. */
export const STAFF_PERSONALITIES = {
  enabled: true,
  experienceHours: { skilled: 80, veteran: 400 },
  experienceRate: { rookie: 0.8, skilled: 1, veteran: 1.2 },
  experienceWage: { rookie: 0.9, skilled: 1, veteran: 1.3 },
  styleTime: { speedy: 0.8, standard: 1, meticulous: 1.25 },
  cleanlinessDelta: { speedy: -10, standard: 0, meticulous: 10 },
  repairTarget: { speedy: 85, standard: 90, meticulous: 95 },
  reliabilityWage: { dependable: 1.1, normal: 1, flaky: 0.95 },
  lateChance: { dependable: 0, normal: 0.05, flaky: 0.2 },
  absentChance: { dependable: 0, normal: 0, flaky: 0.04 },
};

/** Separate people cover the three eight-hour reception shifts. */
export const FRONT_DESK_STAFF = {
  enabled: true,
  shiftWage: 0.55,
  nightPremium: 1.25,
  checkInMinutes: { rookie: 25, skilled: 20, veteran: 16 },
  shifts: {
    early: { start: 6, end: 14, label: 'Early · 06:00–14:00' },
    late: { start: 14, end: 22, label: 'Late · 14:00–22:00' },
    night: { start: 22, end: 30, label: 'Night · 22:00–06:00' },
  },
};
