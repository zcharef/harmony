import { create } from 'zustand'

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

interface ConnectionState {
  status: ConnectionStatus
  // WHY: Incrementing reconnectKey forces useEventSource's useEffect to re-run,
  // tearing down the old EventSource and creating a new one. This is the simplest
  // way to force SSE reconnection without exposing the EventSource instance.
  reconnectKey: number
  setStatus: (status: ConnectionStatus) => void
  requestReconnect: () => void
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  // WHY: Initial status is 'connecting' (not 'connected') because the SSE
  // connection hasn't been established yet at startup. The banner shows
  // "Connecting..." until the EventSource fires onopen.
  status: 'connecting',
  reconnectKey: 0,
  setStatus: (status) => set({ status }),
  requestReconnect: () =>
    set((state) => ({ status: 'reconnecting', reconnectKey: state.reconnectKey + 1 })),
}))

export function useConnectionStatus(): ConnectionStatus {
  return useConnectionStore((state) => state.status)
}
