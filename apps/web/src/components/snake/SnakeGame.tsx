import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { gameKeys, gamesApi } from '../../api/games';
import { toastError } from '../../stores/toast';
import { errorMessage } from '../../lib/errors';
import { cx } from '../ui';
import { COLS, ROWS, newGame, step, stepMs, turn, type Dir, type SnakeState } from './engine';

/*
 * The playfield is drawn the way the old phone screens were: every game cell is 4 x 4 LCD dots, the
 * snake is a chain of 3 x 3 blocks with a one-dot groove, and a swallowed apple shows as a bulge that
 * travels down the body.
 */

/** The classic monochrome phone LCD; the same in light and dark mode because it's a screen, not chrome. */
const LCD = { bg: '#c7f0d8', on: '#43523d', ghost: 'rgba(67, 82, 61, 0.07)' };
const DOTS = 4;
/** Two dots of margin round the field: a border line, then a gap. */
const PAD = 2;
const W = COLS * DOTS + PAD * 2;
const H = ROWS * DOTS + PAD * 2;

type Status = 'idle' | 'running' | 'paused' | 'over';

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

function draw(ctx: CanvasRenderingContext2D, u: number, s: SnakeState) {
  // Dot edges snap to whole pixels from the same grid, so no column ends up a pixel short (a visible seam).
  const gap = u >= 5 ? 1 : 0;
  const dot = (dx: number, dy: number) => {
    const x0 = Math.round(dx * u);
    const y0 = Math.round(dy * u);
    ctx.fillRect(x0, y0, Math.round((dx + 1) * u) - x0 - gap, Math.round((dy + 1) * u) - y0 - gap);
  };
  ctx.fillStyle = LCD.bg;
  ctx.fillRect(0, 0, W * u, H * u);

  // Faint unlit dots give the screen its texture.
  ctx.fillStyle = LCD.ghost;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dot(x, y);

  ctx.fillStyle = LCD.on;
  for (let x = 0; x < W; x++) {
    dot(x, 0);
    dot(x, H - 1);
  }
  for (let y = 1; y < H - 1; y++) {
    dot(0, y);
    dot(W - 1, y);
  }

  const at = (cx: number, cy: number, sx: number, sy: number) => dot(PAD + cx * DOTS + sx, PAD + cy * DOTS + sy);
  const bulges = new Set(s.bulges);

  s.body.forEach((c, i) => {
    const big = bulges.has(i) && i > 0;
    const size = big ? 4 : 3;
    for (let sy = 0; sy < size; sy++) for (let sx = 0; sx < size; sx++) at(c.x, c.y, sx, sy);
    // Join to the segment nearer the head so the body reads as one chain.
    const prev = s.body[i - 1];
    if (prev) {
      if (prev.x === c.x + 1) for (let k = 0; k < 3; k++) at(c.x, c.y, 3, k);
      if (prev.x === c.x - 1) for (let k = 0; k < 3; k++) at(prev.x, prev.y, 3, k);
      if (prev.y === c.y + 1) for (let k = 0; k < 3; k++) at(c.x, c.y, k, 3);
      if (prev.y === c.y - 1) for (let k = 0; k < 3; k++) at(prev.x, prev.y, k, 3);
    }
  });

  // An eye: one unlit dot on the head, towards where it's going.
  const head = s.body[0];
  if (head) {
    const eye = { up: [2, 0], down: [0, 2], left: [0, 0], right: [2, 0] }[s.dir];
    ctx.fillStyle = LCD.bg;
    at(head.x, head.y, eye[0]!, eye[1]!);
  }

  if (s.food.x >= 0) {
    ctx.fillStyle = LCD.on;
    for (const [sx, sy] of [
      [1, 0],
      [0, 1],
      [2, 1],
      [1, 2],
    ] as const)
      at(s.food.x, s.food.y, sx, sy);
  }
}

const pad4 = (n: number) => String(n).padStart(4, '0');

export function SnakeGame({ best }: { best: number | null }) {
  const qc = useQueryClient();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<SnakeState>(newGame());
  const [unit, setUnit] = useState(6);
  const [status, setStatus] = useState<Status>('idle');
  const [score, setScore] = useState(0);
  const [result, setResult] = useState<{ score: number; personalBest: boolean } | null>(null);

  const submit = useMutation({
    mutationFn: gamesApi.submitSnakeScore,
    onSuccess: (r, score) => {
      qc.setQueryData(gameKeys.snakeLeaderboard, r.leaderboard);
      setResult({ score, personalBest: r.personalBest });
    },
    onError: (err) => toastError(`Score not saved: ${errorMessage(err)}`),
  });

  const paint = useCallback(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    draw(ctx, unit * dpr, game.current);
  }, [unit]);

  // Size the screen to the space it has, in whole canvas pixels.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setUnit(Math.max(3, (e?.contentRect.width ?? 600) / W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * unit * dpr);
    c.height = Math.round(H * unit * dpr);
    paint();
  }, [unit, paint]);

  // The loop runs only while playing. Steps are fixed-time, so a slow frame never changes the speed.
  useEffect(() => {
    if (status !== 'running') return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const frame = (now: number) => {
      acc += Math.min(now - last, 250);
      last = now;
      const s = game.current;
      let moved = false;
      while (!s.over && acc >= stepMs(s.score)) {
        acc -= stepMs(s.score);
        if (step(s)) setScore(s.score);
        moved = true;
      }
      if (moved) paint();
      if (s.over) {
        setStatus('over');
        submit.mutate(s.score);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit.mutate is stable
  }, [status, paint]);

  // Leaving the tab pauses the game.
  useEffect(() => {
    const onHide = () => document.hidden && setStatus((s) => (s === 'running' ? 'paused' : s));
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  const start = () => {
    game.current = newGame();
    setScore(0);
    setResult(null);
    paint();
    setStatus('running');
    wrap.current?.focus();
  };

  const primary = () => {
    if (status === 'running') setStatus('paused');
    else if (status === 'paused') {
      setStatus('running');
      wrap.current?.focus();
    } else start();
  };

  const steer = (d: Dir) => {
    if (status === 'idle' || status === 'over') start();
    turn(game.current, d);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const d = KEY_DIR[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (d) {
      e.preventDefault();
      if (status === 'paused') setStatus('running');
      steer(d);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      primary();
    } else if (e.key === 'Escape' && status === 'running') setStatus('paused');
  };

  // Swipes on touch screens.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    const from = swipe.current;
    swipe.current = null;
    if (!from) {
      if (status !== 'running') primary();
      return;
    }
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) {
      if (status !== 'running') primary();
      return;
    }
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  };

  const shownBest = Math.max(best ?? 0, status === 'over' ? score : 0);

  return (
    <div className="rounded-2xl border border-border bg-surface p-3">
      <div
        ref={wrap}
        tabIndex={0}
        role="application"
        aria-label="Snake. Arrow keys or WASD to steer, Space to start or pause"
        onKeyDown={onKey}
        onBlur={() => setStatus((s) => (s === 'running' ? 'paused' : s))}
        className="relative overflow-hidden rounded-lg font-mono shadow-[inset_0_1px_3px_rgba(0,0,0,0.18)] outline-offset-4 select-none"
        style={{ background: LCD.bg, color: LCD.on }}
      >
        <div className="flex items-baseline justify-between px-[3%] pt-2 pb-1 text-sm leading-none">
          <span aria-live="polite" aria-atomic>
            <span className="sr-only">Score </span>
            {pad4(score)}
          </span>
          <span className="text-xs opacity-80">Best {pad4(shownBest)}</span>
        </div>
        <canvas
          ref={canvas}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          className="block touch-none"
          style={{ width: W * unit, height: H * unit }}
        />

        {status !== 'running' && (
          <div className="pointer-events-none absolute inset-x-0 top-8 bottom-0 flex flex-col items-center justify-center gap-2 text-center">
            <div className="rounded px-3 py-2" style={{ background: LCD.bg }}>
              {status === 'idle' && (
                <>
                  <p className="text-lg leading-tight font-medium">Snake</p>
                  <Hint>Space to start</Hint>
                </>
              )}
              {status === 'paused' && (
                <>
                  <p className="text-lg leading-tight font-medium">Paused</p>
                  <Hint>Space to resume</Hint>
                </>
              )}
              {status === 'over' && (
                <>
                  <p className="text-lg leading-tight font-medium">Game over</p>
                  <p className="mt-1 text-sm">
                    {submit.isPending ? 'Saving…' : result?.personalBest ? `New best ${pad4(result.score)}` : `Score ${pad4(score)}`}
                  </p>
                  <Hint>Space to play again</Hint>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-subtle">
          <Key>←</Key> <Key>↑</Key> <Key>↓</Key> <Key>→</Key> or <Key>W</Key> <Key>A</Key> <Key>S</Key> <Key>D</Key> to steer, <Key>Space</Key> to pause
        </p>
        <button
          // Keep focus on the screen, so pressing Pause doesn't first blur (and pause) the game.
          onMouseDown={(e) => e.preventDefault()}
          onClick={primary}
          className="h-8 shrink-0 rounded-md border border-border bg-bg px-3 text-xs font-medium hover:bg-hover"
        >
          {status === 'running' ? 'Pause' : status === 'paused' ? 'Resume' : status === 'over' ? 'Play again' : 'Start'}
        </button>
      </div>

      {/* A d-pad for touch screens; keyboards never see it. */}
      <div className="mx-auto mt-3 hidden w-36 grid-cols-3 gap-1 pointer-coarse:grid">
        <span />
        <Pad label="Up" onPress={() => steer('up')}>
          <ChevronUp className="size-5" />
        </Pad>
        <span />
        <Pad label="Left" onPress={() => steer('left')}>
          <ChevronLeft className="size-5" />
        </Pad>
        <span />
        <Pad label="Right" onPress={() => steer('right')}>
          <ChevronRight className="size-5" />
        </Pad>
        <span />
        <Pad label="Down" onPress={() => steer('down')}>
          <ChevronDown className="size-5" />
        </Pad>
        <span />
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs opacity-80">{children}</p>;
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-border bg-bg px-1 font-mono text-2xs text-muted">{children}</kbd>;
}

function Pad({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={cx('flex size-11 items-center justify-center rounded-md border border-border bg-bg text-muted active:bg-hover')}
    >
      {children}
    </button>
  );
}
