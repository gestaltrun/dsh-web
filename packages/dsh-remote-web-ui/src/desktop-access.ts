/** Optional Desktop Host listener owned independently of the native Fetch carrier. */
export interface DesktopRemoteAccess {
  /**
   * Allocate the startup port on loopback before constructing the pairing proxy.
   * @param port - Startup port; zero requests an available port.
   * @returns Bound listener facts.
   */
  initialize(port: number): Promise<DesktopRemoteState>
  /**
   * Apply the enabled/LAN setting and await the serialized close/rebind.
   * @param selection - Desired listener exposure.
   * @returns Listener facts after the transition.
   */
  configure(selection: { enabled: boolean; lanBind: boolean }): Promise<DesktopRemoteState>
  /** @returns Actual listening facts, including bind failures. */
  status(): DesktopRemoteState
  /**
   * Observe completed bind transitions.
   * @param listener - Receives actual bind facts.
   * @returns An idempotent unsubscribe.
   */
  onChange(listener: (state: DesktopRemoteState) => void): () => void
}

/** Actual HTTP listener state; a disabled or failed listener advertises no LAN URLs. */
export interface DesktopRemoteState {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly listening: boolean
  readonly error?: string
}
