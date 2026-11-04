import type { ClientSession, Types } from 'mongoose';
import { Workspace, type IWorkspace } from '../models/Workspace';

export const workspaceRepository = {
  findById(id: Types.ObjectId, session?: ClientSession) {
    return Workspace.findById(id).session(session ?? null).lean<IWorkspace>();
  },

  findByIds(ids: Types.ObjectId[]) {
    return Workspace.find({ _id: { $in: ids } }).lean<IWorkspace[]>();
  },

  findBySlug(slug: string) {
    return Workspace.findOne({ slug }).lean<IWorkspace>();
  },

  async slugExists(slug: string): Promise<boolean> {
    return (await Workspace.exists({ slug }).setOptions({ withDeleted: true })) !== null;
  },

  async create(doc: Partial<IWorkspace>, session: ClientSession): Promise<IWorkspace> {
    const [created] = await Workspace.create([doc], { session });
    return created!.toObject<IWorkspace>();
  },

  async setOwner(id: Types.ObjectId, ownerId: Types.ObjectId, session: ClientSession): Promise<void> {
    await Workspace.updateOne({ _id: id }, { $set: { ownerId, createdBy: ownerId } }, { session });
  },
};
