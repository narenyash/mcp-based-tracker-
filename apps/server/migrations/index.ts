import type { Migration } from '../src/db/migrator';
import { migration as m0001 } from './0001-initial';
import { migration as m0002 } from './0002-tasks';
import { migration as m0003 } from './0003-notifications';
import { migration as m0004 } from './0004-tickets';
import { migration as m0005 } from './0005-collab';
import { migration as m0006 } from './0006-goals';
import { migration as m0007 } from './0007-boards';
import { migration as m0008 } from './0008-planning';
import { migration as m0009 } from './0009-idempotency';
import { migration as m0010 } from './0010-games';

/** Ordered list of all migrations. Append only; never edit or reorder an applied migration. */
export const MIGRATIONS: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010];
