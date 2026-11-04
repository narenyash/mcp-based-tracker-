/**
 * Comments, attachments and the activity log. Imported once at startup (src/modules/register.ts).
 * Installs the real activity writer, so every module's recordActivity() lands in the append-only log.
 */
import { setActivitySink } from '../../services/activity';
import { writeActivity } from './activity.service';

setActivitySink(writeActivity);
