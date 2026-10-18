/** Individual staff: phase 4. Later phases add fatigue, shifts and morale. */
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
