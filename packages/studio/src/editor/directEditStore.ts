import { create } from "zustand";

/**
 * Lightweight global store for direct-manipulation edit mode.
 *
 * Keeping this out of App.tsx lets the header toggle, the overlay, and any
 * future inspector panels share the same selection/hover state without
 * drilling props through the entire tree.
 */
interface DirectEditState {
  enabled: boolean;
  selectedId: string | null;
  hoveredId: string | null;
  editingTextId: string | null;

  setEnabled: (v: boolean) => void;
  toggleEnabled: () => void;
  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setEditingText: (id: string | null) => void;
  clear: () => void;
}

export const useDirectEditStore = create<DirectEditState>((set) => ({
  enabled: false,
  selectedId: null,
  hoveredId: null,
  editingTextId: null,

  setEnabled: (v) =>
    set({
      enabled: v,
      selectedId: null,
      hoveredId: null,
      editingTextId: null,
    }),
  toggleEnabled: () =>
    set((s) => ({
      enabled: !s.enabled,
      selectedId: null,
      hoveredId: null,
      editingTextId: null,
    })),
  setSelected: (id) => set({ selectedId: id, editingTextId: null }),
  setHovered: (id) => set({ hoveredId: id }),
  setEditingText: (id) => set({ editingTextId: id }),
  clear: () => set({ selectedId: null, hoveredId: null, editingTextId: null }),
}));
