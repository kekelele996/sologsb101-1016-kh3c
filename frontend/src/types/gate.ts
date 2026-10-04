/**
 * 闸门（Gate）
 * 连接上游池与下游池的串级通道，开度决定下游预计进水量。
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
  /** 池系归属：升级时按上下游池反推补上；反推不出来的留空（没主的闸门只读） */
  seriesName: string
  /** 开度（%） */
  openingPct: number
  /** 口宽（cm） */
  widthCm: number
  /** 闸门状态 */
  state: GateState
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑闸门的表单草稿 */
export interface GateDraft {
  fromPondId: string
  toPondId: string
  seriesName: string
  openingPct: number
  widthCm: number
  state: GateState
  note: string
}
