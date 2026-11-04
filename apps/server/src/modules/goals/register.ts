/**
 * Phase 6: daily / weekly / monthly goals, progress, carry-over, rollover.
 * Imported once at startup (src/modules/register.ts): entity resolver, discovery sources and the
 * task listener that keeps goal progress in step with linked tasks.
 */
import { registerEntity } from '../../services/entityAccess';
import { registerCalendarSource, registerSearchSource } from '../../services/discovery';
import { bus } from '../../events/bus';
import { goalsService } from './goals.service';

registerEntity('goal', (ctx, id) => goalsService.resolveEntity(ctx, id));

registerSearchSource('goals', (ctx, q, limit) => goalsService.search(ctx, q, limit));

registerCalendarSource('goals', (ctx, range) => goalsService.calendar(ctx, range));

bus.on('task.changed', (e) => goalsService.onTaskChanged(e));
