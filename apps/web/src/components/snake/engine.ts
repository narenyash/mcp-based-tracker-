import { SNAKE_COLS, SNAKE_POINTS_PER_APPLE, SNAKE_ROWS } from '@teamtrack/shared';

/*
 * Snake rules, kept free of React and the canvas so the loop stays simple: walls and your own tail end
 * the game, every apple adds a segment and speeds the snake up a little.
 */

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface Cell {
  x: number;
  y: number;
}

export interface SnakeState {
  /** Head first. */
  body: Cell[];
  dir: Dir;
  /** Turns pressed faster than the snake moves, applied one per step. */
  queue: Dir[];
  food: Cell;
  /** Segments still to add from apples already eaten. */
  grow: number;
  /** Body indexes of swallowed apples, travelling towards the tail. */
  bulges: number[];
  score: number;
  over: boolean;
}

export const COLS = SNAKE_COLS;
export const ROWS = SNAKE_ROWS;

const STEP: Record<Dir, Cell> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** Milliseconds per step: 150 at the start, 2 faster per apple, never under 70. */
export const stepMs = (score: number) => Math.max(70, 150 - (score / SNAKE_POINTS_PER_APPLE) * 2);

function placeFood(body: Cell[]): Cell {
  const taken = new Set(body.map((c) => c.y * COLS + c.x));
  const free = COLS * ROWS - taken.size;
  if (free <= 0) return { x: -1, y: -1 };
  let n = Math.floor(Math.random() * free);
  for (let i = 0; i < COLS * ROWS; i++) {
    if (taken.has(i)) continue;
    if (n-- === 0) return { x: i % COLS, y: Math.floor(i / COLS) };
  }
  return { x: -1, y: -1 };
}

export function newGame(): SnakeState {
  const y = Math.floor(ROWS / 2);
  const body = [5, 4, 3, 2].map((x) => ({ x, y }));
  return { body, dir: 'right', queue: [], food: placeFood(body), grow: 0, bulges: [], score: 0, over: false };
}

/** Queues a turn; reversing into yourself and repeats are ignored. At most two turns wait. */
export function turn(s: SnakeState, d: Dir): void {
  const last = s.queue.at(-1) ?? s.dir;
  if (d === last || d === OPPOSITE[last] || s.queue.length >= 2) return;
  s.queue.push(d);
}

/** Advances one step. Returns true when an apple was eaten. */
export function step(s: SnakeState): boolean {
  if (s.over) return false;
  s.dir = s.queue.shift() ?? s.dir;
  const head = s.body[0]!;
  const next = { x: head.x + STEP[s.dir].x, y: head.y + STEP[s.dir].y };
  // The tail moves away this step unless the snake is growing, so it's a safe square.
  const body = s.grow > 0 ? s.body : s.body.slice(0, -1);
  if (next.x < 0 || next.y < 0 || next.x >= COLS || next.y >= ROWS || body.some((c) => c.x === next.x && c.y === next.y)) {
    s.over = true;
    return false;
  }
  s.body.unshift(next);
  if (s.grow > 0) s.grow--;
  else s.body.pop();
  s.bulges = s.bulges.map((i) => i + 1).filter((i) => i < s.body.length);

  if (next.x !== s.food.x || next.y !== s.food.y) return false;
  s.score += SNAKE_POINTS_PER_APPLE;
  s.grow++;
  s.bulges.push(0);
  s.food = placeFood(s.body);
  if (s.food.x < 0) s.over = true; // the board is full
  return true;
}
