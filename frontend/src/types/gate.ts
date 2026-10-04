/**
 * 闸门（Gate）
 * 连接上游池与下游池的串级通道，开度决定下游预计进水量。
 * 闸门串级台账归盐田管护班维护，调度室只读不写。
 */

/** 闸门状态：关闭 / 半开 / 全开 */
export type GateState = '关闭' | '半开' | '全开'

export const GATE_STATE_OPTIONS: GateState[] = ['关闭', '半开', '全开']

export interface Gate {
  id: string
  /** 上游池 */
  fromPondId: string
  /** 下游池 */
  toPondId: string
  /** 开度（%） */
  openingPct: number
  /** 口宽（cm） */
  widthCm: number
  /** 闸门状态 */
  state: GateState
  /** 池系归属（管护班台账口径）：v3 升级时按上下游池反推，反推不出为空串（无主闸，只读） */
  seriesName: string
  /** 归属是否由升级程序反推补齐（true 时若仍无归属则为只读无主闸） */
  ownerInferred: boolean
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 无主闸的 seriesName 占位值：反推不出池系归属的旧闸门只读展示 */
export const GATE_NO_OWNER = ''

/** 新建 / 编辑闸门的表单草稿 */
export interface GateDraft {
  fromPondId: string
  toPondId: string
  openingPct: number
  widthCm: number
  state: GateState
  seriesName: string
  note: string
}
