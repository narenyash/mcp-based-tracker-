import express, { Router } from 'express';
import { MAX_ATTACHMENT_BYTES } from '@teamtrack/shared';
import { collabController } from './collab.controller';

/** Comments + @mentions, attachments and the activity log. Mounted after authentication in src/routes.ts. */
export function collabRouter(): Router {
  const r = Router();

  r.get('/comments', collabController.listComments);
  r.post('/comments', collabController.createComment);
  r.patch('/comments/:id', collabController.updateComment);
  r.delete('/comments/:id', collabController.removeComment);
  r.get('/mentionable', collabController.mentionable);

  r.get('/attachments', collabController.listAttachments);
  // Uploads go through the API so size and type are checked here; the raw body parser is on this route only.
  r.post('/attachments', express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }), collabController.uploadAttachment);
  r.delete('/attachments/:id', collabController.removeAttachment);

  r.get('/activity', collabController.listActivity);
  return r;
}
