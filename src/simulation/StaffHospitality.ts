import type { Guest, HotelState, StaffMember, StayLeg } from './types.js';
import { STAFF_HOSPITALITY as RULES, STAFF_PERSONALITIES, STAFF_SPECIALTIES } from '../config/staff.js';
import { VOICE } from '../config/balance.js';
import { hospitalityOf, specialtyOf } from './StaffProfiles.js';
import { moodHidden } from './Voice.js';

type ContactKind = 'check_in' | 'complaint' | 'daily_clean';

/** Saved on the service leg: reassignment cannot change an encounter already underway. */
export function serviceSnapshot(member: StaffMember | undefined): Partial<StayLeg> {
  return { serviceStaffId: member?.id, serviceName: member ? member.name ?? member.id : undefined,
    serviceHospitality: member ? hospitalityOf(member) : undefined, serviceSpecialty: member ? specialtyOf(member) : undefined };
}

export function serviceMember(state: HotelState, stay: StayLeg): StaffMember | undefined {
  if (!stay.serviceStaffId) return undefined;
  const member = state.staffRoster?.find(m => m.id === stay.serviceStaffId);
  if (!member) return undefined;
  return { ...member, name: stay.serviceName ?? member.name, profile: {
    experience: member.profile?.experience ?? 'skilled', style: member.profile?.style ?? 'standard',
    reliability: member.profile?.reliability ?? 'dependable', ...member.profile,
    ...(stay.serviceHospitality ? { hospitality: stay.serviceHospitality } : {}),
    ...(stay.serviceSpecialty ? { specialty: stay.serviceSpecialty } : {}),
  } };
}

/** Call only when the named employee actually meets this guest. Neutral contact is a no-op. */
export function recordHospitality(guest: Guest, member: StaffMember, kind: ContactKind, at: number): Guest {
  if (!STAFF_PERSONALITIES.enabled) return guest;
  const hospitality = hospitalityOf(member);
  const concierge = STAFF_SPECIALTIES.enabled && member.role === 'front_desk'
    && kind !== 'daily_clean' && specialtyOf(member) === 'concierge';
  const contacts = guest.service?.contacts ?? [];
  if (kind === 'daily_clean' ? guest.service?.lastDailyCleanDay === Math.floor(at / 24)
    : kind === 'check_in' ? guest.service?.checkedIn : guest.service?.complained) return guest;
  if (contacts.some(c => c.kind === kind && (kind !== 'daily_clean' || Math.floor(c.at / 24) === Math.floor(at / 24)))) return guest;
  const mood = kind === 'check_in' ? RULES.checkInMood[hospitality]
    : kind === 'daily_clean' ? RULES.dailyCleanMood[hospitality]
    : hospitality === 'warm' ? RULES.warmComplaintMood - VOICE.heardMood : 0;
  if (mood === 0 && !concierge) return guest;
  const contact = { staffId: member.id, name: member.name ?? member.id, kind, at, hospitality, mood };
  return { ...guest, satisfaction: Math.max(0, Math.min(100, guest.satisfaction + mood)), service: {
    ...guest.service, contacts: [...contacts, contact].slice(-RULES.maxContacts),
    ...(kind === 'daily_clean' ? { lastDailyCleanDay: Math.floor(at / 24) } : kind === 'check_in' ? { checkedIn: true } : { complained: true }),
    hospitalityMood: Math.max(-RULES.maxReview / RULES.reviewPerMood,
      Math.min(RULES.maxReview / RULES.reviewPerMood, (guest.service?.hospitalityMood ?? 0) + mood)),
    ...(concierge ? { concierge: { staffId: member.id, name: contact.name, at } } : {}),
  } };
}

export function hospitalityReview(guest: Guest): { score: number; praise?: string; criticism?: string } {
  if (!STAFF_PERSONALITIES.enabled || !RULES.enabled) return { score: 0 };
  const score = Math.max(-RULES.maxReview, Math.min(RULES.maxReview, (guest.service?.hospitalityMood ?? 0) * RULES.reviewPerMood));
  if (score === 0) return { score };
  const contacts = (guest.service?.contacts ?? []).filter(c => score > 0 ? c.mood > 0 : c.mood < 0);
  const names = [...new Set(contacts.map(c => c.name))].slice(0, 2).join(' and ');
  return score > 0 ? { score, praise: `${names || 'The staff'} made them feel welcome` }
    : { score, criticism: `${names || 'The staff'} came across as curt` };
}

export const isMoodKnown = (guest: Guest): boolean => !moodHidden(guest)
  || STAFF_PERSONALITIES.enabled && STAFF_SPECIALTIES.enabled && !!guest.service?.concierge;

/** Phone grace comes from someone physically at the desk, once when the incident opens. */
export function recordNoiseHospitality(state: HotelState, guest: Guest, at: number): { guest: Guest; grace: number; clerk?: StaffMember } {
  if (!STAFF_PERSONALITIES.enabled || !RULES.enabled) return { guest, grace: 0 };
  const ids = new Set((state.staffPlan?.itineraries ?? []).filter(it => it.legs.some(l =>
    l.kind === 'stay' && l.activity === 'desk' && l.start <= at && l.end > at)).map(it => it.staffId));
  const clerk = state.staffRoster?.find(m => m.role === 'front_desk' && ids.has(m.id) && hospitalityOf(m) === 'warm');
  return clerk ? { guest, grace: RULES.warmNoiseGrace, clerk } : { guest, grace: 0 };
}
