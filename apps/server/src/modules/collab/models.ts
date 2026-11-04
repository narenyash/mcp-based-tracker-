import { Activity } from '../../models/Activity';
import { Attachment } from '../../models/Attachment';
import { Comment } from '../../models/Comment';

/** Comments, attachments and the activity log: synced by `db:migrate` like every other model. */
export const COLLAB_MODELS: ReadonlyArray<{ syncIndexes(): Promise<unknown> }> = [Comment, Attachment, Activity];
