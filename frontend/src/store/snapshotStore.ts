import { create } from 'zustand';

import * as api from '../api/client';
import type {
  CreateResultSnapshotPayload,
  UpdateResultSnapshotPayload,
} from '../api/payloads';
import type { ResultSnapshot, ResultSnapshotDetail } from '../types';

interface SnapshotState {
  snapshots: ResultSnapshot[];
  selectedSnapshot: ResultSnapshotDetail | null;
  isLoading: boolean;
  error: string | null;
}

interface SnapshotActions {
  loadSnapshots: (options?: {
    limit?: number;
    starred_only?: boolean;
    tag?: string;
    provider_id?: string;
    model_id?: string;
  }) => Promise<void>;
  createSnapshot: (payload: CreateResultSnapshotPayload) => Promise<ResultSnapshot | null>;
  updateSnapshot: (
    snapshotId: string,
    payload: UpdateResultSnapshotPayload,
  ) => Promise<ResultSnapshot | null>;
  deleteSnapshot: (snapshotId: string) => Promise<boolean>;
  selectSnapshot: (snapshotId: string | null) => Promise<void>;
  clearError: () => void;
}

export const useSnapshotStore = create<SnapshotState & SnapshotActions>((set) => ({
  snapshots: [],
  selectedSnapshot: null,
  isLoading: false,
  error: null,

  loadSnapshots: async (options) => {
    set({ isLoading: true, error: null });
    try {
      const snapshots = await api.listResultSnapshots(options);
      set({ snapshots, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load snapshots';
      set({ error: message, isLoading: false });
    }
  },

  createSnapshot: async (payload) => {
    set({ isLoading: true, error: null });
    try {
      const snapshot = await api.createResultSnapshot(payload);
      set((state) => ({
        snapshots: [snapshot, ...state.snapshots],
        isLoading: false,
      }));
      return snapshot;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create snapshot';
      set({ error: message, isLoading: false });
      return null;
    }
  },

  updateSnapshot: async (snapshotId, payload) => {
    set({ isLoading: true, error: null });
    try {
      const snapshot = await api.updateResultSnapshot(snapshotId, payload);
      set((state) => ({
        snapshots: state.snapshots.map((item) =>
          item.snapshot_id === snapshotId ? snapshot : item,
        ),
        selectedSnapshot:
          state.selectedSnapshot?.snapshot.snapshot_id === snapshotId
            ? { ...state.selectedSnapshot, snapshot }
            : state.selectedSnapshot,
        isLoading: false,
      }));
      return snapshot;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update snapshot';
      set({ error: message, isLoading: false });
      return null;
    }
  },

  deleteSnapshot: async (snapshotId) => {
    set({ isLoading: true, error: null });
    try {
      await api.deleteResultSnapshot(snapshotId);
      set((state) => ({
        snapshots: state.snapshots.filter((item) => item.snapshot_id !== snapshotId),
        selectedSnapshot:
          state.selectedSnapshot?.snapshot.snapshot_id === snapshotId
            ? null
            : state.selectedSnapshot,
        isLoading: false,
      }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete snapshot';
      set({ error: message, isLoading: false });
      return false;
    }
  },

  selectSnapshot: async (snapshotId) => {
    if (!snapshotId) {
      set({ selectedSnapshot: null });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const detail = await api.getResultSnapshot(snapshotId);
      set({ selectedSnapshot: detail, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load snapshot detail';
      set({ error: message, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
