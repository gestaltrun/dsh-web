/** Compatibility API for plugins with Workshop install reporting disabled. */

export type TelemetryChannel = 'market' | 'npm' | 'unknown'

export interface TelemetryItem {
  /** npm package name or asset id, e.g. "@gestaltrun/dsh-pet" or "skin:harbor". */
  name: string
  /** Installed version when known; omitted otherwise. */
  version?: string
  /** Install channel when determinable (market = Workshop install). */
  channel?: TelemetryChannel
}

/**
 * Accept installed items without collecting identifiers or sending requests.
 * @param _items - Package or asset identities supplied by existing plugin callers.
 */
export function reportDailyHeartbeat(_items: readonly TelemetryItem[]): void {}
