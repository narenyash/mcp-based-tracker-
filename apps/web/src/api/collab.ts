import type { ActivityDto, AttachmentDto, CommentDto, CreateCommentInput, EntityRef, MentionableUserDto, Page } from '@teamtrack/shared';
import { api } from './client';

const ifMatch = (version: number) => ({ headers: { 'If-Match': `"${version}"` } });

/** Uploads can be up to 10 MB, so they get a longer timeout than the API default. */
const UPLOAD_TIMEOUT_MS = 120_000;

export const commentsApi = {
  list: (ref: EntityRef, params: { cursor?: string | undefined; limit?: number } = {}) =>
    api.get<Page<CommentDto>>('/comments', { params: { ...ref, ...params } }).then((r) => r.data),
  create: (input: CreateCommentInput) => api.post<CommentDto>('/comments', input).then((r) => r.data),
  update: (id: string, body: string, version: number) => api.patch<CommentDto>(`/comments/${id}`, { body }, ifMatch(version)).then((r) => r.data),
  remove: (id: string) => api.delete(`/comments/${id}`),
  mentionable: (ref: EntityRef, q: string) =>
    api.get<{ items: MentionableUserDto[] }>('/mentionable', { params: { ...ref, ...(q ? { q } : {}) } }).then((r) => r.data.items),
};

export const attachmentsApi = {
  list: (ref: EntityRef) => api.get<{ items: AttachmentDto[] }>('/attachments', { params: ref }).then((r) => r.data.items),
  /** The file is the raw request body; the server identifies its type from the bytes. */
  upload: (ref: EntityRef, file: File, onProgress?: (fraction: number) => void) =>
    api
      .post<AttachmentDto>('/attachments', file, {
        params: { ...ref, fileName: file.name || 'file' },
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        timeout: UPLOAD_TIMEOUT_MS,
        onUploadProgress: (e) => {
          if (onProgress && e.total) onProgress(e.loaded / e.total);
        },
      })
      .then((r) => r.data),
  remove: (id: string) => api.delete(`/attachments/${id}`),
};

export const activityApi = {
  list: (ref: EntityRef, params: { cursor?: string | undefined; limit?: number } = {}) =>
    api.get<Page<ActivityDto>>('/activity', { params: { ...ref, ...params } }).then((r) => r.data),
};
