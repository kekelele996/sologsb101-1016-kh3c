/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 走水计划台账归调度室维护，盐田管护班只读不写。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 放行/重检时通路或容量检查的失败类型 */
export type ScheduleBlockKind = 'path' | 'capacity'

export interface Schedule {
  id: string
  /** 上游（水源）蒸发池 */
  pondId: string
  /** 目标下游池（放行时校验从 pondId 到该池的闸门串级）；旧数据升级时按唯一下游池反推 */
  targetPondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 放行时锁定的通路闸门 id 链（管护班改闸后据此识别作废的旧通路） */
  routeGateIds: string[]
  /** 放行时锁定的通路上池 id 链（上游池 → … → 目标池） */
  routePondIds: string[]
  /** 最近一次被打回/排队的原因类型：通路断 / 容量不足 */
  blockedKind: ScheduleBlockKind | ''
  /** 最近一次被打回/排队的文字说明（写明断在哪道闸门，或容量差量） */
  blockedReason: string
  /** 下游池排队差量（m³）：容量不足排队时 = 计划量 − 下游尚余容量，> 0 表示排队中 */
  shortfallM3: number
  /** 放行时间（ISO），用于容量占用与审计 */
  releasedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  targetPondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
