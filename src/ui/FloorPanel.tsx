import { ELEVATOR } from '../config/balance';
import { getNextFloorCost, getElevatorLoad } from '../simulation/HotelState';
import { useController } from './context';
import { formatMoney } from './format';

/** The building's floors as a stack, ground floor at the bottom; build the next one on the roof. */
export function FloorPanel() {
  const c = useController();
  const { state } = c;
  const cost = getNextFloorCost(state);
  const floors = Array.from({ length: state.floorCount }, (_, i) => state.floorCount - 1 - i); // top first

  const upper = state.rooms.filter(r => r.floor > 0).length;
  let elevatorLine: string;
  if (state.floorCount === 1) {
    elevatorLine = 'Upper floors need an elevator';
  } else if (state.elevators.length === 0) {
    elevatorLine = upper > 0 ? 'No elevator: upper rooms unbookable!' : 'Build an elevator to use upper floors';
  } else {
    const busy = getElevatorLoad(state) > 1 ? ' (busy!)' : '';
    elevatorLine = `Elevators: ${state.elevators.length}, ${upper}/${state.elevators.length * ELEVATOR.roomsServed} upper rooms${busy}`;
  }

  return (
    <aside class="card floor-panel" aria-label="Floors">
      <div class="card-title">FLOORS</div>
      {cost !== null && (
        <button class="primary" style={{ width: '100%', marginBottom: '6px' }} disabled={state.cash < cost} onClick={() => c.buildFloor()}>
          + Floor {state.floorCount + 1} ({formatMoney(cost)})
        </button>
      )}
      {floors.map(floor => (
        <button
          key={floor}
          class={`floor-row${floor === c.currentFloor ? ' active' : ''}`}
          aria-pressed={floor === c.currentFloor}
          onClick={() => c.setFloor(floor)}
        >
          {floor === c.currentFloor ? '▶ ' : '  '}{floor === 0 ? 'Ground' : `Floor ${floor + 1}`}
          {'  '}{state.rooms.filter(r => r.floor === floor).length} rooms
        </button>
      ))}
      <div class={`tiny ${elevatorLine.includes('!') ? 'bad' : 'dim'}`}>{elevatorLine}</div>
      <div class="tiny faint" style={{ marginTop: '4px' }}>PageUp / PageDown to switch</div>
    </aside>
  );
}
