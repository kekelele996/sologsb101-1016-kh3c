/**
 * 调度室 ⨝ 管护班 联动服务（调度室侧）
 *
 * 台账边界：本文件只「读」闸门/蒸发池（管护班台账），只「写」走水计划（调度室台账），
 * 不提供任何反向写闸门的入口——两边各自记账，谁也不改对方。
 *
 * 规则：
 * 1. 放行（待排 → 已排）时按管护班「当下」闸门走向查上游池 → 目标池通不通；
 *    走不通退回待排，写明断在哪道闸门；下游池容量不够先排队，写清差量。
 * 2. 管护班关掉通路 / 改派下游池 / 拆闸后，靠旧通路排的计划（已排、走水中）
 *    一律退回待排重排；已出卤的历史记录保留不动。
 * 3. 小幅调开度（闸门仍开着）不影响旧通路快照，不打回任何计划。
 */
import type { Gate } from '../types/gate';
import type { Pond } from '../types/pond';
import type { Observation } from '../types/observation';
import type { Schedule, ScheduleBlockKind } from '../types/schedule';
import { db } from './db';
import { nowIso } from './id';
import { withSideRetry } from './retry';
import { capacityOf, findBlockage, findOpenRoute, isGateOpen, type Blockage, type Route } from './topology';

const DISPATCH_SIDE = '调度室走水侧' as const;

/** 放行/开始走水检查结果 */
export interface DispatchCheck {
  ok: boolean
  kind: ScheduleBlockKind | ''
  /** 写回计划的阻断说明（写明断点闸门或容量差量） */
  reason: string
  /** 放行成功时锁定的当下通路 */
  route: Route | null
  /** 容量排队差量（m³），0 表示不缺 */
  shortfallM3: number
  /** 下游尚余容量（m³） */
  freeM3: number
  /** 断掉的闸门 id（拆除闸为空串，容量问题为空串） */
  blockedGateId: string
}

/** 重检后被退回重排的计划摘要 */
export interface RevalidationItem {
  scheduleId: string
  reason: string
  gateId: string
}

export interface RevalidationResult {
  /** 被退回待排的计划条数（已出卤的不计、不动） */
  resetCount: number
  items: RevalidationItem[]
}

/* -------------------------------- 文案拼装 -------------------------------- */

function pondCode(ponds: Pond[], pondId: string): string {
  const pond = ponds.find((item) => item.id === pondId)
  return pond === undefined ? `已删池(${pondId.slice(-4)})` : pond.code
}

function gateEndpoints(gate: Gate, ponds: Pond[]): string {
  return `${pondCode(ponds, gate.fromPondId)} → ${pondCode(ponds, gate.toPondId)}`
}

/** 断点 → 人话：断在哪道闸门、那道闸现在怎么了 */
function blockageText(
  blockage: Blockage,
  gates: Gate[],
  ponds: Pond[],
  fromPondId: string,
  toPondId: string,
): string {
  const target = pondCode(ponds, toPondId)
  if (blockage.gateId === '') {
    return `当前走向走不通：${pondCode(ponds, fromPondId)} 到 ${target} 之间没有可通行的闸门串级，请联系管护班确认走向后重排`
  }
  const gate = gates.find((item) => item.id === blockage.gateId)
  if (gate === undefined) {
    return `通路已断：第 ${blockage.gateId} 号闸门已被管护班拆除，${pondCode(ponds, fromPondId)} 无法到 ${target}，计划退回待排`
  }
  return `通路已断：闸门「${gateEndpoints(gate, ponds)}」当前${isGateOpen(gate) ? '未在通行方向上' : '已关闭'}（开度 ${gate.openingPct}%），${pondCode(ponds, fromPondId)} 到 ${target} 走不通，退回待排重排`
}

/* -------------------------------- 数据快照 -------------------------------- */

interface SnapshotData {
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  schedules: Schedule[]
}

async function loadSnapshot(txPonds?: Pond[], txGates?: Gate[], txObservations?: Observation[], txSchedules?: Schedule[]): Promise<SnapshotData> {
  const [ponds, gates, observations, schedules] = await Promise.all([
    txPonds ?? db.ponds.toArray(),
    txGates ?? db.gates.toArray(),
    txObservations ?? db.observations.toArray(),
    txSchedules ?? db.schedules.toArray(),
  ])
  return { ponds, gates, observations, schedules }
}

/** 下游池最近观测水位（无观测返回 null，按半池水估算） */
function latestLevelOf(observations: Observation[], pondId: string): number | null {
  const list = observations
    .filter((row) => row.pondId === pondId)
    .sort((a, b) => a.date.localeCompare(b.date))
  return list.length === 0 ? null : list[list.length - 1].levelCm
}

/**
 * 放行评估：先查通路，再查下游容量。
 * 每一次都按管护班「当下」闸门走向实时计算，不复用旧快照。
 */
export function evaluateDispatch(schedule: Schedule, data: SnapshotData): DispatchCheck {
  const { ponds, gates, observations, schedules } = data

  if (schedule.targetPondId === '') {
    return fail('path', '未指定目标下游池，无法按闸门串级放行，请补排目标池后重试', null)
  }
  if (schedule.pondId === schedule.targetPondId) {
    return fail('path', '上游池与目标池不能是同一口池，请重新选择目标下游池', null)
  }
  const target = ponds.find((pond) => pond.id === schedule.targetPondId)
  if (target === undefined) {
    return fail('path', '目标下游池已被删除，请重新选择目标池后再放行', null)
  }

  // 1) 通路检查：当下走向查上游池 → 目标池
  const route = findOpenRoute(gates, schedule.pondId, schedule.targetPondId)
  if (route === null) {
    const blockage = findBlockage(gates, schedule.pondId, schedule.targetPondId)
    return fail('path', blockageText(blockage, gates, ponds, schedule.pondId, schedule.targetPondId), blockage.gateId)
  }

  // 2) 容量检查：已放行（已排 / 走水中）且目标相同的计划先占用容量
  const reservations = schedules.filter(
    (row) =>
      row.id !== schedule.id &&
      row.targetPondId === target.id &&
      (row.state === '已排' || row.state === '走水中'),
  )
  const info = capacityOf(target, latestLevelOf(observations, target.id), reservations)
  const shortfall = Math.round((schedule.volumeM3 - info.freeM3) * 10) / 10
  if (shortfall > 0) {
    const reason = `下游池 ${target.code} 容量不足：尚余容量 ${info.freeM3} m³，本计划 ${schedule.volumeM3} m³，差额 ${shortfall} m³，已排队待容量腾出后再放行`
    return {
      ok: false,
      kind: 'capacity',
      reason,
      route: null,
      shortfallM3: shortfall,
      freeM3: info.freeM3,
      blockedGateId: '',
    }
  }

  return {
    ok: true,
    kind: '',
    reason: '',
    route,
    shortfallM3: 0,
    freeM3: Math.round(info.freeM3 * 10) / 10,
    blockedGateId: '',
  }
}

function fail(kind: ScheduleBlockKind, reason: string, gateId: string | null): DispatchCheck {
  return { ok: false, kind, reason, route: null, shortfallM3: 0, freeM3: 0, blockedGateId: gateId ?? '' }
}

/* --------------------------------- 放行 --------------------------------- */

/**
 * 调度室放行：待排 → 已排。
 * - 通路走不通：退回待排（state 保持待排），写明断点闸门；
 * - 下游容量不足：留在待排排队，写清差量；
 * - 放行成功：锁定当下通路快照，防止日后沿作废的旧通路走水。
 * 只写 schedules 一张表（调度室台账），闸门数据只读。
 */
export async function dispatchSchedule(scheduleId: string): Promise<DispatchCheck> {
  return withSideRetry(async () => {
    const data = await loadSnapshot()
    const schedule = data.schedules.find((row) => row.id === scheduleId)
    if (schedule === undefined) return fail('path', '计划不存在或已被删除', null)
    if (schedule.state === '已出卤') return fail('path', '该计划已出卤完成，无需放行', null)

    const check = evaluateDispatch(schedule, data)
    const stamp = nowIso()
    if (check.ok && check.route !== null) {
      await db.schedules.update(scheduleId, {
        state: '已排',
        routeGateIds: check.route.gateIds,
        routePondIds: check.route.pondIds,
        blockedKind: '',
        blockedReason: '',
        shortfallM3: 0,
        releasedAt: schedule.releasedAt === '' ? stamp : schedule.releasedAt,
        updatedAt: stamp,
      })
    } else if (check.kind === 'capacity') {
      // 容量不足：排队，状态不动（仍待排），写清差量
      await db.schedules.update(scheduleId, {
        blockedKind: 'capacity',
        blockedReason: check.reason,
        shortfallM3: check.shortfallM3,
        routeGateIds: [],
        routePondIds: [],
        releasedAt: '',
        updatedAt: stamp,
      })
    } else {
      // 通路走不通：退回待排，写明断在哪道闸门
      await db.schedules.update(scheduleId, {
        state: '待排',
        blockedKind: 'path',
        blockedReason: check.reason,
        shortfallM3: 0,
        routeGateIds: [],
        routePondIds: [],
        releasedAt: '',
        updatedAt: stamp,
      })
    }
    return check
  }, { side: DISPATCH_SIDE })
}

/* --------------------------- 开始走水前旧通路复核 --------------------------- */

/**
 * 按放行时锁定的通路快照，逐条核对管护班当下的闸门。
 * 返回 null 表示旧通路仍然有效；否则返回作废原因（写明是哪道闸关了 / 改派 / 拆了）。
 * 快照里每道闸的 id、上下游、开闭都要与放行时一致；最后再按当下走向确认整条链
 * 仍能抵达目标池（防止旧链中间某道闸虽在、但已被改派到别处导致沿作废通路走水）。
 */
export function checkRouteStale(schedule: Schedule, gates: Gate[], ponds: Pond[]): RevalidationItem | null {
  if (schedule.routeGateIds.length === 0) {
    // 旧数据没有快照：退化为当下连通性检查
    const route = findOpenRoute(gates, schedule.pondId, schedule.targetPondId)
    if (route !== null) return null
    const blockage = findBlockage(gates, schedule.pondId, schedule.targetPondId)
    return {
      scheduleId: schedule.id,
      reason: blockageText(blockage, gates, ponds, schedule.pondId, schedule.targetPondId),
      gateId: blockage.gateId,
    }
  }
  for (let i = 0; i < schedule.routeGateIds.length; i += 1) {
    const gateId = schedule.routeGateIds[i]
    const expectedFrom = schedule.routePondIds[i] ?? ''
    const expectedTo = schedule.routePondIds[i + 1] ?? ''
    const gate = gates.find((item) => item.id === gateId)
    if (gate === undefined) {
      return {
        scheduleId: schedule.id,
        reason: `管护班已拆除原通路闸门（${pondCode(ponds, expectedFrom)} → ${pondCode(ponds, expectedTo)}），旧通路作废，计划退回待排重排`,
        gateId: '',
      }
    }
    if (gate.fromPondId !== expectedFrom || gate.toPondId !== expectedTo) {
      return {
        scheduleId: schedule.id,
        reason: `闸门「${pondCode(ponds, expectedFrom)} → ${pondCode(ponds, expectedTo)}」已被管护班改派下游（现走向 ${gateEndpoints(gate, ponds)}），旧通路作废，退回待排重排`,
        gateId: gate.id,
      }
    }
    if (!isGateOpen(gate)) {
      return {
        scheduleId: schedule.id,
        reason: `闸门「${gateEndpoints(gate, ponds)}」已被管护班关闭（开度 ${gate.openingPct}%），靠该通路排的计划退回待排重排`,
        gateId: gate.id,
      }
    }
  }
  // 快照上的每道闸都原样开放，但改派可能把水流引到别的池：再按当下走向确认能到目标池
  if (findOpenRoute(gates, schedule.pondId, schedule.targetPondId) === null) {
    const blockage = findBlockage(gates, schedule.pondId, schedule.targetPondId, schedule.routeGateIds)
    return {
      scheduleId: schedule.id,
      reason: blockageText(blockage, gates, ponds, schedule.pondId, schedule.targetPondId),
      gateId: blockage.gateId,
    }
  }
  return null
}

/**
 * 已排计划开始走水（已排 → 走水中）前再按当下闸门复核一次旧通路，
 * 不让计划沿着作废的旧通路真的走水。失败返回作废原因，计划退回待排。
 */
export async function startFlowOrRequeue(scheduleId: string): Promise<{ ok: boolean; reason: string }> {
  return withSideRetry(async () => {
    const data = await loadSnapshot()
    const schedule = data.schedules.find((row) => row.id === scheduleId)
    if (schedule === undefined) return { ok: false, reason: '计划不存在或已被删除' }
    if (schedule.state !== '已排') return { ok: false, reason: '只有「已排」状态的计划可以开始走水' }
    const stale = checkRouteStale(schedule, data.gates, data.ponds)
    const stamp = nowIso()
    if (stale !== null) {
      await db.schedules.update(scheduleId, {
        state: '待排',
        blockedKind: 'path',
        blockedReason: stale.reason,
        shortfallM3: 0,
        routeGateIds: [],
        routePondIds: [],
        releasedAt: '',
        updatedAt: stamp,
      })
      return { ok: false, reason: stale.reason }
    }
    await db.schedules.update(scheduleId, { state: '走水中', blockedKind: '', blockedReason: '', shortfallM3: 0, updatedAt: stamp })
    return { ok: true, reason: '' }
  }, { side: DISPATCH_SIDE })
}

/* --------------------- 管护班改闸后的调度侧全量重检 --------------------- */

/**
 * 重检所有未完成（已排 / 走水中）的计划：
 * 关闸 / 改派下游 / 拆闸导致旧通路作废的，退回待排重排，写明断在哪道闸；
 * 小幅调开度（闸仍开着）不打回；已出卤的历史计划保留不动。
 * 调度编排页挂载时、管护班每次结构性改闸后各执行一次。
 */
export async function revalidateActiveSchedules(): Promise<RevalidationResult> {
  return withSideRetry(async () => {
    const data = await loadSnapshot()
    const items: RevalidationItem[] = []
    const stamp = nowIso()
    for (const schedule of data.schedules) {
      if (schedule.state !== '已排' && schedule.state !== '走水中') continue
      if (schedule.targetPondId === '') {
        items.push({ scheduleId: schedule.id, reason: '旧计划缺少目标下游池，补排目标池并重新放行后才能继续', gateId: '' })
        continue
      }
      const stale = checkRouteStale(schedule, data.gates, data.ponds)
      if (stale !== null) items.push(stale)
    }
    if (items.length > 0) {
      const ids = new Set(items.map((item) => item.scheduleId))
      const reasonById = new Map(items.map((item) => [item.scheduleId, item.reason]))
      await db.schedules.toCollection().modify((row: Schedule) => {
        if (!ids.has(row.id)) return
        row.state = '待排'
        row.blockedKind = 'path'
        row.blockedReason = reasonById.get(row.id) ?? ''
        row.shortfallM3 = 0
        row.routeGateIds = []
        row.routePondIds = []
        row.releasedAt = ''
        row.updatedAt = stamp
      })
    }
    return { resetCount: items.length, items }
  }, { side: DISPATCH_SIDE })
}

/** 清除排队/打回标记：编辑计划或重新放行成功后调用 */
export async function clearBlockMarks(scheduleId: string): Promise<void> {
  await withSideRetry(async () => {
    await db.schedules.update(scheduleId, {
      blockedKind: '',
      blockedReason: '',
      shortfallM3: 0,
      updatedAt: nowIso(),
    })
  }, { side: DISPATCH_SIDE })
}
