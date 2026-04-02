import { create } from 'zustand'

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

interface ConnectionState {
  status: ConnectionStatus
  // WHY: Surfaces a specific error message (e.g., "Email not verified" on 403)
  // in the ConnectionBanner when the SSE connection cannot be established.
  errorMessage: string | null
  // WHY: Incrementing reconnectKey forces useFetchSSE's useEffect to re-run,
  // tearing down the old fetch connection and creating a new one. This is the
  // simplest way to force SSE reconnection without exposing the AbortController.
  reconnectKey: number
  setStatus: (status: ConnectionStatus, errorMessage?: string | null) => void
  requestReconnect: () => void
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  // WHY: Initial status is 'connecting' (not 'connected') because the SSE
  // connection hasn't been established yet at startup. The banner shows
  // "Connecting..." until the EventSource fires onopen.
  status: 'connecting',
  errorMessage: null,
  reconnectKey: 0,
  setStatus: (status, errorMessage) => set({ status, errorMessage: errorMessage ?? null }),
  requestReconnect: () =>
    set((state) => ({ status: 'reconnecting', reconnectKey: state.reconnectKey + 1 })),
}))

export function useConnectionStatus(): ConnectionStatus {
  return useConnectionStore((state) => state.status)
}
