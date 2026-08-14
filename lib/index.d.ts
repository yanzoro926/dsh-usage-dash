/**
 * dsh-usage-dash host half type surface (advisory; the plugin ships as plain
 * ESM JavaScript).
 */
export declare const name: string
export declare const inject: string[]
export declare const GO_LIMITS: Readonly<{ rolling5h: number; weekly: number; monthly: number }>
export interface SpendRow { t: number; c: number }
export interface UsageWindow {
  key: 'rolling5h' | 'weekly' | 'monthly'
  label: string
  spentUsd: number
  limitUsd: number
  pct: number
  remainingUsd: number
  resetAtMs: number | null
  note: string | undefined
}
export declare function opencodeDbPath(): string
export declare function readSpendRows(dbPath?: string): { rows: SpendRow[]; note: 'no-data' | undefined }
export declare function computeSummary(rows: SpendRow[], now?: number): { allTimeUsd: number; windows: UsageWindow[] }
export declare function apply(ctx: unknown): void
