import type {
  CreateWhiteboardInput,
  Page,
  SaveSceneInput,
  WhiteboardDetailDto,
  WhiteboardDto,
  WhiteboardFileDto,
  WhiteboardSnapshotDto,
} from '@teamtrack/shared';
import { api } from './client';

const ifMatch = (version: number) => ({ headers: { 'If-Match': `"${version}"` } });

/** Gzips JSON with the browser's CompressionStream (scenes easily pass the 1 MB JSON body limit). */
async function gzipJson(value: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export interface BoardListParams {
  projectId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export const boardsApi = {
  list: (params: BoardListParams) => api.get<Page<WhiteboardDto>>('/boards', { params }).then((r) => r.data),
  get: (id: string) => api.get<WhiteboardDetailDto>(`/boards/${id}`).then((r) => r.data),
  create: (input: CreateWhiteboardInput) => api.post<WhiteboardDto>('/boards', input).then((r) => r.data),
  rename: (id: string, title: string, version: number) => api.patch<WhiteboardDto>(`/boards/${id}`, { title }, ifMatch(version)).then((r) => r.data),
  remove: (id: string) => api.delete(`/boards/${id}`),

  /** PUT /boards/:id/scene as gzipped JSON. A 409 STALE_VERSION carries the current `sceneVersion`. */
  saveScene: async (id: string, input: SaveSceneInput) => {
    const body = await gzipJson(input);
    return api.put<WhiteboardDto>(`/boards/${id}/scene`, body, { headers: { 'Content-Type': 'application/gzip' }, timeout: 60_000 }).then((r) => r.data);
  },

  snapshots: (id: string) => api.get<{ items: WhiteboardSnapshotDto[] }>(`/boards/${id}/snapshots`).then((r) => r.data.items),
  restore: (id: string, snapshotId: string) => api.post<WhiteboardDetailDto>(`/boards/${id}/snapshots/${snapshotId}/restore`).then((r) => r.data),

  /** Uploads an image as the raw body; the server sniffs the real type and issues the file id. */
  uploadFile: (id: string, file: Blob) =>
    api
      .post<WhiteboardFileDto>(`/boards/${id}/files`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream' }, timeout: 60_000 })
      .then((r) => r.data),
  /** Image bytes through the API (authenticated, no bucket CORS needed). */
  fileContent: (id: string, fileId: string) => api.get<Blob>(`/boards/${id}/files/${fileId}/content`, { responseType: 'blob' }).then((r) => r.data),
  setThumbnail: (id: string, png: Blob) => api.put(`/boards/${id}/thumbnail`, png, { headers: { 'Content-Type': 'image/png' } }),
};
