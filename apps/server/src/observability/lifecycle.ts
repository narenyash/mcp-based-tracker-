/**
 * Process lifecycle flags shared by the HTTP layer and the shutdown sequence. Once draining, /readyz
 * answers 503 so load balancers stop routing new traffic here while in-flight requests finish.
 */
let draining = false;

export function markDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}
