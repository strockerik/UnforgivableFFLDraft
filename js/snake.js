// Snake draft pick math.
//
// For an N-team snake, team t picks at:
//   odd  round r: (r-1)*N + t
//   even round r: (r-1)*N + (N - t + 1)
// So in a 10-team league from slot 5 you pick 5th in odd rounds and 6th in
// even rounds: overall picks 5, 16, 25, 36, ...

export function pickNumber(round, slot, teams) {
  const base = (round - 1) * teams;
  return round % 2 === 1 ? base + slot : base + (teams - slot + 1);
}

/** Every overall pick number belonging to `slot`, in order. */
export function myPicks(settings) {
  const { rounds, slot, teams } = settings;
  const out = [];
  for (let r = 1; r <= rounds; r++) out.push(pickNumber(r, slot, teams));
  return out;
}

/** Which round an overall pick falls in (1-indexed). */
export function roundOf(pickNo, teams) {
  return Math.floor((pickNo - 1) / teams) + 1;
}

/** Which slot is on the clock at an overall pick number. */
export function slotOnClock(pickNo, teams) {
  const round = roundOf(pickNo, teams);
  const idx = ((pickNo - 1) % teams) + 1;
  return round % 2 === 1 ? idx : teams - idx + 1;
}

/**
 * Draft position summary for the pick currently on the clock.
 * `current` is the 1-indexed overall pick about to be made.
 */
export function draftPosition(current, settings) {
  const { teams, slot, rounds } = settings;
  const mine = myPicks(settings);
  const onClock = slotOnClock(current, teams);
  const isMine = onClock === slot;

  const next = mine.find((p) => p >= current) ?? null;
  const following = mine.find((p) => p > (next ?? current)) ?? null;

  return {
    pickNo: current,
    round: roundOf(current, teams),
    rounds,
    slotOnClock: onClock,
    isMyPick: isMine,
    nextPick: next,
    picksUntilMyTurn: next == null ? null : Math.max(0, next - current),
    // How many picks elapse between this turn and the one after it — the
    // window a player has to survive if you wait.
    gapToFollowingPick: next != null && following != null ? following - next : null,
    complete: current > teams * rounds,
  };
}
