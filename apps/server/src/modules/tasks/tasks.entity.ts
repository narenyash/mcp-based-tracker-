import { registerEntity } from '../../services/entityAccess';
import { taskPath } from '../../services/notifier';
import { taskRepository } from '../../repositories/taskRepository';
import { NotFoundError } from '../../errors/AppError';
import { projectsService } from '../projects/projects.service';

registerEntity('task', async (ctx, id) => {
  const task = await taskRepository.findById(ctx.workspaceId, id);
  if (!task) return null;
  try {
    const a = await projectsService.access(ctx, task.projectId);
    const writable = a.canEdit && a.project.status === 'active';
    return {
      type: 'task',
      id: task._id,
      projectId: task.projectId,
      projectName: a.project.name,
      key: task.key,
      title: task.title,
      path: taskPath(task.projectId.toHexString(), task._id.toHexString()),
      canWrite: writable,
      canManage: writable && a.canManage,
      participants: [task.reporterId, task.assigneeId, task.testerId].filter((x): x is NonNullable<typeof x> => !!x),
    };
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
});
