import type { RoomProfile } from '../simulation/RoomProfile';
import { whoSuits } from '../simulation/Preferences';

/** Who a room suits, under "Fits ...": "Good for business travellers" and "Couples won't like separate beds" (nothing for a plain room). */
export function RoomSuits({ profile }: { profile: RoomProfile }) {
  const { goodFor, notFor } = whoSuits(profile);
  return (
    <>
      {goodFor.length > 0 && <div class="dim small good-for">Good for {goodFor.join(', ')}</div>}
      {notFor.map(n => (
        <div key={n.label} class="small warn-text">{n.label.charAt(0).toUpperCase() + n.label.slice(1)} won't like {n.because}</div>
      ))}
    </>
  );
}
