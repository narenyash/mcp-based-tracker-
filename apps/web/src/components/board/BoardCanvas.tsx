import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  getSceneVersion,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, DataURL, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement, FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import { WHITEBOARD_LIMITS, type BoardPresence, type SceneAppState, type SceneElement, type ServerToClientEvents, type WhiteboardDetailDto } from '@teamtrack/shared';
import { boardsApi } from '../../api/boards';
import { blobToDataURL, colorFor, staleSceneVersion } from '../../lib/boards';
import { errorMessage, problemOf } from '../../lib/errors';
import { getSocket, useSocketEvent } from '../../lib/realtime';
import { useAuth } from '../../stores/auth';
import { toastError } from '../../stores/toast';

/*
 * The Excalidraw canvas and everything that needs Excalidraw at runtime (lazy-loaded with this module).
 *
 * Sync model (mirrors the server, which relays and doesn't merge):
 *  - Live: changed elements (by id + version) go to the board room, throttled; incoming ones are merged
 *    with Excalidraw's reconcileElements (higher version wins, versionNonce breaks ties).
 *  - Durable: the whole scene is autosaved (gzipped) with `baseVersion`. A 409 means someone else saved
 *    first: fetch their scene, reconcile, retry on top of it.
 *  - Images: Excalidraw's generateIdForFile uploads the file, so element fileIds are server-issued ids
 *    that every client can fetch.
 */

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

export interface BoardCanvasHandle {
  /** Adopts a scene the server just produced (after a restore). */
  applyDetail: (detail: WhiteboardDetailDto) => void;
  /** Saves now if there are unsaved changes. */
  flush: () => Promise<void>;
}

interface Props {
  board: WhiteboardDetailDto;
  canEdit: boolean;
  dark: boolean;
  onPresence: (users: BoardPresence['users']) => void;
  onStatus: (s: SaveStatus) => void;
  /** Called after each successful save, with the new sceneVersion. */
  onSaved: (sceneVersion: number) => void;
  handleRef: Ref<BoardCanvasHandle>;
}

const BROADCAST_MS = 80;
const POINTER_MS = 50; // the server drops beyond 20/s
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_MAX_WAIT_MS = 10_000;
const RETRY_MS = 10_000;
const THUMBNAIL_EVERY_MS = 30_000;
const THUMBNAIL_SIZE = 480;
/** The server relays at most 1000 elements and 512 KB of JSON per message, and drops the socket over 600 KB. */
const RELAY_CHUNK = 500;
const RELAY_CHUNK_BYTES = 384 * 1024;
const utf8 = new TextEncoder();

/** Splits elements into relay messages under both caps. Elements too big to relay on their own are left to the save. */
function relayChunks(elements: SceneElement[]): SceneElement[][] {
  const chunks: SceneElement[][] = [];
  let chunk: SceneElement[] = [];
  let bytes = 2;
  for (const e of elements) {
    const size = utf8.encode(JSON.stringify(e)).length + 1;
    if (size + 2 > RELAY_CHUNK_BYTES) continue;
    if (chunk.length && (chunk.length >= RELAY_CHUNK || bytes + size > RELAY_CHUNK_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(e);
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
/** Deleted elements are kept in saves for a while so late editors still see the deletion win. */
const TOMBSTONE_TTL_MS = 24 * 3600 * 1000;

const toExcalidraw = (els: readonly unknown[]) => els as readonly ExcalidrawElement[];
const toScene = (els: readonly ExcalidrawElement[]) => els as unknown as SceneElement[];

function sceneAppState(a: Pick<AppState, 'viewBackgroundColor' | 'gridSize' | 'gridModeEnabled'>): SceneAppState {
  return { viewBackgroundColor: a.viewBackgroundColor, gridSize: a.gridModeEnabled ? Math.min(100, Math.max(1, Math.round(a.gridSize))) : null };
}
const appStateKey = (s: SceneAppState) => `${s.viewBackgroundColor ?? ''}|${s.gridSize ?? ''}`;

export default function BoardCanvas({ board, canEdit, dark, onPresence, onStatus, onSaved, handleRef }: Props) {
  const boardId = board.id;
  const me = useAuth((s) => s.user);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // Latest callbacks, so effects and socket handlers never go stale.
  const cb = useRef({ onPresence, onStatus, onSaved, canEdit });
  useEffect(() => {
    cb.current = { onPresence, onStatus, onSaved, canEdit };
  });

  // Sync state lives in one mutable object: none of it should re-render React.
  const [st] = useState(() => ({
    baseVersion: board.sceneVersion,
    /** Element versions peers already have (sent or received). */
    peerVersions: new Map<string, number>(board.scene.elements.map((e) => [e.id, e.version])),
    lastSceneHash: -1,
    lastAppStateKey: appStateKey(board.scene.appState),
    dirty: false,
    /** Bumped on every local change, so a save that raced with an edit stays dirty. */
    changeSeq: 0,
    saving: null as Promise<void> | null,
    saveTimer: 0,
    firstDirtyAt: 0,
    broadcastTimer: 0,
    retryTimer: 0,
    lastPointerAt: 0,
    lastThumbnailAt: 0,
    stopped: false,
    mountGen: 0,
    knownFiles: new Set<string>(),
    collaborators: new Map<SocketId, Collaborator>(),
    /**
     * The scene as of the last onChange. Excalidraw clears its scene when it unmounts (before our effect
     * cleanups run), so the save on leaving the page must not read it through the API.
     */
    latest: null as { elements: readonly OrderedExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null,
    unmounted: false,
  }));

  const elementsNow = useCallback(
    (): readonly OrderedExcalidrawElement[] =>
      st.unmounted || !apiRef.current ? (st.latest?.elements ?? []) : (apiRef.current.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[]),
    [st],
  );

  /* ---------------------------------------------------------------- files */

  const loadFiles = useCallback(
    (fileIds: Iterable<string>) => {
      const api = apiRef.current;
      if (!api) return;
      const missing = [...fileIds].filter((id) => !st.knownFiles.has(id));
      missing.forEach((id) => st.knownFiles.add(id));
      if (!missing.length) return;
      void Promise.allSettled(
        missing.map(async (id): Promise<BinaryFileData> => {
          const blob = await boardsApi.fileContent(boardId, id);
          return { id: id as FileId, mimeType: blob.type as BinaryFileData['mimeType'], dataURL: (await blobToDataURL(blob)) as DataURL, created: Date.now() };
        }),
      ).then((results) => {
        const loaded = results.flatMap((r, i) => {
          if (r.status === 'fulfilled') return [r.value];
          st.knownFiles.delete(missing[i]!); // allow a later retry
          return [];
        });
        if (loaded.length && !st.stopped) apiRef.current?.addFiles(loaded);
      });
    },
    [boardId, st],
  );

  const loadReferencedFiles = useCallback(
    (els: readonly ExcalidrawElement[]) => {
      const ids: string[] = [];
      for (const e of els) if (e.type === 'image' && !e.isDeleted && e.fileId) ids.push(e.fileId);
      loadFiles(ids);
    },
    [loadFiles],
  );

  /* ---------------------------------------------------------------- merging */

  /** Merges elements from elsewhere (peers, the server) into the canvas. */
  const applyRemote = useCallback(
    (remote: readonly unknown[]) => {
      const api = apiRef.current;
      if (!api || !remote.length) return;
      const restored = restoreElements(toExcalidraw(remote), null) as RemoteExcalidrawElement[];
      if (st.unmounted) {
        // Only the final save on leaving gets here (after a 409): merge into the captured scene.
        if (st.latest) st.latest = { ...st.latest, elements: reconcileElements(st.latest.elements, restored, st.latest.appState) };
        return;
      }
      const merged = reconcileElements(elementsNow(), restored, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
      // Peers already have what they sent us; where our copy won, it goes out on the next broadcast.
      const incoming = new Map(restored.map((e) => [e.id, e.version]));
      for (const e of merged) if (incoming.get(e.id) === e.version) st.peerVersions.set(e.id, e.version);
      loadReferencedFiles(merged);
    },
    [st, elementsNow, loadReferencedFiles],
  );

  /* ---------------------------------------------------------------- saving */

  const uploadThumbnail = useCallback(async () => {
    const scene = st.latest;
    if (!scene || Date.now() - st.lastThumbnailAt < THUMBNAIL_EVERY_MS) return;
    st.lastThumbnailAt = Date.now();
    const elements = scene.elements.filter((e) => !e.isDeleted);
    if (!elements.length) return;
    try {
      const blob = await exportToBlob({
        elements,
        appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false },
        files: scene.files,
        maxWidthOrHeight: THUMBNAIL_SIZE,
        mimeType: 'image/png',
        exportPadding: 16,
      });
      if (blob.size <= WHITEBOARD_LIMITS.maxThumbnailBytes) await boardsApi.setThumbnail(boardId, blob);
    } catch {
      // A missing preview is cosmetic; the next save tries again.
      st.lastThumbnailAt = 0;
    }
  }, [boardId, st]);

  const save = useCallback(async (): Promise<void> => {
    if (st.saving) {
      await st.saving;
      if (st.dirty) return save();
      return;
    }
    const api = apiRef.current;
    if (!api || !st.dirty || !cb.current.canEdit) return;
    window.clearTimeout(st.saveTimer);
    window.clearTimeout(st.retryTimer);
    st.saveTimer = 0;
    st.firstDirtyAt = 0;

    const run = async () => {
      cb.current.onStatus('saving');
      for (let attempt = 0; attempt < 4; attempt++) {
        const seq = st.changeSeq;
        const cutoff = Date.now() - TOMBSTONE_TTL_MS;
        const elements = elementsNow().filter((e) => !e.isDeleted || e.updated > cutoff);
        if (elements.filter((e) => !e.isDeleted).length > WHITEBOARD_LIMITS.maxElements) {
          cb.current.onStatus('error');
          toastError(`A board can hold at most ${WHITEBOARD_LIMITS.maxElements} elements`);
          return;
        }
        try {
          const saved = await boardsApi.saveScene(boardId, {
            elements: toScene(elements),
            appState: sceneAppState(st.unmounted && st.latest ? st.latest.appState : api.getAppState()),
            baseVersion: st.baseVersion,
            reason: 'autosave',
          });
          st.baseVersion = saved.sceneVersion;
          if (st.changeSeq === seq) st.dirty = false;
          cb.current.onStatus(st.dirty ? 'unsaved' : 'saved');
          cb.current.onSaved(saved.sceneVersion);
          void uploadThumbnail();
          return;
        } catch (err) {
          const current = staleSceneVersion(err);
          if (current === null) {
            cb.current.onStatus('error');
            const status = problemOf(err)?.status;
            // Permission or archive changes won't fix themselves; network and server errors might.
            if (status === 403 || status === 404 || status === 409 || status === 413) toastError(errorMessage(err));
            else if (!st.stopped) st.retryTimer = window.setTimeout(() => void save(), RETRY_MS);
            return;
          }
          // Someone saved first: take their scene, merge ours on top, try again.
          try {
            const latest = await boardsApi.get(boardId);
            applyRemote(latest.scene.elements);
            st.baseVersion = latest.sceneVersion;
          } catch (e) {
            cb.current.onStatus('error');
            toastError(errorMessage(e));
            return;
          }
        }
      }
      cb.current.onStatus('error');
    };

    st.saving = run().finally(() => {
      st.saving = null;
    });
    await st.saving;
  }, [boardId, st, elementsNow, applyRemote, uploadThumbnail]);

  const markDirty = useCallback(() => {
    st.dirty = true;
    st.changeSeq++;
    cb.current.onStatus('unsaved');
    const now = Date.now();
    st.firstDirtyAt ||= now;
    window.clearTimeout(st.saveTimer);
    const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, st.firstDirtyAt + SAVE_MAX_WAIT_MS - now));
    st.saveTimer = window.setTimeout(() => void save(), wait);
  }, [st, save]);

  /* ---------------------------------------------------------------- broadcasting */

  /** Sends elements whose version peers haven't seen, in relay-sized chunks. */
  const broadcast = useCallback(() => {
    st.broadcastTimer = 0;
    if (!cb.current.canEdit) return;
    const changed = elementsNow().filter((e) => st.peerVersions.get(e.id) !== e.version);
    if (!changed.length) return;
    markDirty();
    // Offline: leave peerVersions alone so these go out with the next broadcast. (Peers that missed
    // them meanwhile catch up from the save when they rejoin.)
    const s = getSocket();
    if (!s.connected) return;
    // Oversized elements are skipped by relayChunks but still marked: they reach peers through the save.
    for (const e of changed) st.peerVersions.set(e.id, e.version);
    for (const elements of relayChunks(toScene(changed))) s.emit('board:scene', { boardId, elements });
  }, [boardId, st, elementsNow, markDirty]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      st.latest = { elements, appState, files };
      if (!cb.current.canEdit) return;
      const hash = getSceneVersion(elements);
      if (hash !== st.lastSceneHash) {
        st.lastSceneHash = hash;
        st.broadcastTimer ||= window.setTimeout(broadcast, BROADCAST_MS);
      }
      const key = appStateKey(sceneAppState(appState));
      if (key !== st.lastAppStateKey) {
        st.lastAppStateKey = key;
        markDirty();
      }
    },
    [st, broadcast, markDirty],
  );

  const onPointerUpdate = useCallback(
    ({ pointer }: { pointer: { x: number; y: number } }) => {
      const now = Date.now();
      if (now - st.lastPointerAt < POINTER_MS) return;
      st.lastPointerAt = now;
      const s = getSocket();
      if (s.connected) s.emit('board:pointer', { boardId, x: pointer.x, y: pointer.y });
    },
    [boardId, st],
  );

  /* ---------------------------------------------------------------- images */

  const generateIdForFile = useCallback(
    async (file: File): Promise<string> => {
      if (!cb.current.canEdit) throw new Error('This board is read-only');
      try {
        const { fileId } = await boardsApi.uploadFile(boardId, file);
        st.knownFiles.add(fileId);
        return fileId;
      } catch (err) {
        toastError(errorMessage(err));
        throw err;
      }
    },
    [boardId, st],
  );

  /* ---------------------------------------------------------------- realtime */

  useEffect(() => {
    const s = getSocket();
    let joined = false;
    const join = () =>
      s.emit('board:join', boardId, (res) => {
        if (!res.ok) return toastError('Live updates are unavailable for this board');
        // Rejoining after a disconnect: catch up on what was saved meanwhile (live messages were missed).
        if (joined)
          void boardsApi
            .get(boardId)
            .then((latest) => {
              if (st.saving) return; // the save's own conflict handling will merge
              applyRemote(latest.scene.elements);
              st.baseVersion = latest.sceneVersion;
            })
            .catch(() => undefined);
        joined = true;
      });
    if (s.connected) join();
    s.on('connect', join); // rooms don't survive a reconnect
    return () => {
      s.off('connect', join);
      if (s.connected) s.emit('board:leave', boardId);
    };
  }, [boardId, st, applyRemote]);

  const onScene = useCallback<ServerToClientEvents['board:scene']>(
    (e) => {
      if (e.boardId !== boardId) return;
      applyRemote(e.elements);
    },
    [boardId, applyRemote],
  );
  useSocketEvent('board:scene', onScene);

  const pushCollaborators = useCallback(() => {
    apiRef.current?.updateScene({ collaborators: new Map(st.collaborators) });
  }, [st]);

  const onPointer = useCallback<ServerToClientEvents['board:pointer']>(
    (e) => {
      if (e.boardId !== boardId || e.userId === me?.id) return;
      const color = colorFor(e.userId);
      st.collaborators.set(e.userId as SocketId, {
        id: e.userId,
        username: e.name,
        pointer: { x: e.x, y: e.y, tool: 'pointer' },
        color: { background: color, stroke: color },
      });
      pushCollaborators();
    },
    [boardId, me?.id, st, pushCollaborators],
  );
  useSocketEvent('board:pointer', onPointer);

  const onPresenceEvent = useCallback<ServerToClientEvents['board:presence']>(
    (e) => {
      if (e.boardId !== boardId) return;
      cb.current.onPresence(e.users);
      const ids = new Set(e.users.map((u) => u.id));
      let changed = false;
      for (const id of st.collaborators.keys()) {
        if (!ids.has(id)) {
          st.collaborators.delete(id);
          changed = true;
        }
      }
      if (changed) pushCollaborators();
    },
    [boardId, st, pushCollaborators],
  );
  useSocketEvent('board:presence', onPresenceEvent);

  /* ---------------------------------------------------------------- lifecycle */

  useImperativeHandle(
    handleRef,
    () => ({
      applyDetail: (detail) => {
        applyRemote(detail.scene.elements);
        const bg = detail.scene.appState.viewBackgroundColor;
        if (bg) apiRef.current?.updateScene({ appState: { viewBackgroundColor: bg }, captureUpdate: CaptureUpdateAction.NEVER });
        st.lastAppStateKey = apiRef.current ? appStateKey(sceneAppState(apiRef.current.getAppState())) : st.lastAppStateKey;
        st.baseVersion = Math.max(st.baseVersion, detail.sceneVersion);
        loadFiles(Object.keys(detail.scene.files));
      },
      flush: () => save(),
    }),
    [applyRemote, loadFiles, save, st],
  );

  // Warn before closing the tab with unsaved work, and save what's left when leaving the page.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (st.dirty || st.saving) e.preventDefault();
    };
    const gen = ++st.mountGen;
    st.stopped = false;
    st.unmounted = false;
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      st.unmounted = true;
      window.removeEventListener('beforeunload', beforeUnload);
      window.clearTimeout(st.retryTimer);
      if (st.broadcastTimer) {
        window.clearTimeout(st.broadcastTimer);
        broadcast();
      }
      void save().finally(() => {
        if (st.mountGen === gen) st.stopped = true;
      });
    };
  }, [st, broadcast, save]);

  const onApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      loadFiles(Object.keys(board.scene.files));
    },
    // Only the first scene's files: later ones arrive through applyRemote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadFiles],
  );

  const initialAppState = board.scene.appState;
  return (
    <Excalidraw
      excalidrawAPI={onApi}
      initialData={{
        elements: restoreElements(toExcalidraw(board.scene.elements), null),
        appState: {
          ...(initialAppState.viewBackgroundColor ? { viewBackgroundColor: initialAppState.viewBackgroundColor } : {}),
          gridModeEnabled: initialAppState.gridSize != null,
          ...(initialAppState.gridSize ? { gridSize: initialAppState.gridSize } : {}),
        },
        scrollToContent: true,
      }}
      onChange={onChange}
      onPointerUpdate={onPointerUpdate}
      generateIdForFile={generateIdForFile}
      viewModeEnabled={!canEdit}
      theme={dark ? 'dark' : 'light'}
      name={board.title}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
    />
  );
}
