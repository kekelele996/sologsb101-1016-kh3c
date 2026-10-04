/**
 * 串级拓扑工具（纯函数，不读写数据库）
 * 调度室放行时按管护班「当下」的闸门走向查上游池 → 目标池通不通；
 * 管护班改闸后，调度室再用放行时锁定的通路快照判断旧通路是否作废。
 */
import type { Gate } from '../types/gate';
import type { Pond } from '../types/pond';
import { pondVolumeM3 } from './brine';

/** 可通行闸门：未关闭且开度 > 0 */
export function isGateOpen(gate: Pick<Gate, 'state' | 'openingPct'>): boolean {
  return gate.state !== '关闭' && gate.openingPct > 0;
}

/** 某池的下游可通行闸门（按 toPondId 排序保证路径选择稳定） */
export function openOutboundGates(gates: Gate[], pondId: string): Gate[] {
  return gates
    .filter((gate) => gate.fromPondId === pondId && isGateOpen(gate))
    .sort((a, b) => a.toPondId.localeCompare(b.toPondId) || a.id.localeCompare(b.id));
}

/** BFS 找到的一条通路 */
export interface Route {
  gateIds: string[]
  /** 从上游池到目标池依次经过的池 id（含首尾） */
  pondIds: string[]
}

/**
 * 按当前闸门走向，BFS 查上游池到目标池的一条可通行通路。
 * 找不到返回 null（调用方再用 findBlockage 写明断在哪道闸门）。
 */
export function findOpenRoute(gates: Gate[], fromPondId: string, toPondId: string): Route | null {
  if (fromPondId === '' || toPondId === '' || fromPondId === toPondId) return null;
  const queue: Array<{ pondId: string; gateIds: string[]; pondIds: string[] }> = [
    { pondId: fromPondId, gateIds: [], pondIds: [fromPondId] },
  ];
  const visited = new Set<string>([fromPondId]);
  while (queue.length > 0) {
    const current = queue.shift() as (typeof queue)[number];
    for (const gate of openOutboundGates(gates, current.pondId)) {
      if (visited.has(gate.toPondId)) continue;
      const next = {
        pondId: gate.toPondId,
        gateIds: [...current.gateIds, gate.id],
        pondIds: [...current.pondIds, gate.toPondId],
      };
      if (gate.toPondId === toPondId) return { gateIds: next.gateIds, pondIds: next.pondIds };
      visited.add(gate.toPondId);
      queue.push(next);
    }
  }
  return null;
}

/** 断点描述 */
export interface Blockage {
  /** 断掉的闸门 id：最后一道可达池上关闭/不存在的出口；无可达出口为空串 */
  gateId: string
  /** 断点所在池（上游侧）id */
  pondId: string
  /** 从起点可达的最远池 id */
  reachablePondId: string
}

/**
 * 通路走不通时定位断点：返回最后一个可达池，以及该池朝目标方向的第一道问题闸门。
 * 有放行快照时（旧通路作废场景）沿快照链逐闸核对：
 * 链上第一道「被拆 / 已关 / 改派到别处」的闸门就是断点，其上游池即最后可达池；
 * 没有快照时（首次放行排查），取可达池上任一关闭的出向闸。
 */
export function findBlockage(
  gates: Gate[],
  fromPondId: string,
  toPondId: string,
  snapshotGateIds?: string[],
): Blockage {
  if (snapshotGateIds !== undefined && snapshotGateIds.length > 0) {
    // 沿旧通路链逐闸走：reachedPondId 为按当下开放闸实际走到的池
    let reachedPondId = fromPondId;
    for (const gateId of snapshotGateIds) {
      const gate = gates.find((item) => item.id === gateId);
      const reachableSoFar = reachedPondId;
      if (gate === undefined) {
        // 闸被拆除：断点就是这道（已不存在的）闸
        return { gateId: '', pondId: reachableSoFar, reachablePondId: reachableSoFar };
      }
      if (gate.fromPondId !== reachableSoFar || !isGateOpen(gate)) {
        // 被改派（from 对不上）或已关闭
        return { gateId: gate.id, pondId: reachableSoFar, reachablePondId: reachableSoFar };
      }
      reachedPondId = gate.toPondId;
    }
    // 快照链上的闸看似都在，但走到的终点不是目标池（改派把水引向别处）
    if (reachedPondId !== toPondId) {
      const lastGateId = snapshotGateIds[snapshotGateIds.length - 1] ?? '';
      const lastGate = gates.find((item) => item.id === lastGateId);
      return {
        gateId: lastGateId,
        pondId: lastGate?.fromPondId ?? reachedPondId,
        reachablePondId: reachedPondId,
      };
    }
  }

  // 无快照：BFS 求可达池，层序找第一道关闭的出向闸（优先朝目标方向）
  const reachable = new Set<string>([fromPondId]);
  const queue = [fromPondId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const gate of openOutboundGates(gates, current)) {
      if (!reachable.has(gate.toPondId)) {
        reachable.add(gate.toPondId);
        queue.push(gate.toPondId);
      }
    }
  }
  const seen = new Set<string>([fromPondId]);
  const walk = [fromPondId];
  while (walk.length > 0) {
    const current = walk.shift() as string;
    const outbound = gates
      .filter((gate) => gate.fromPondId === current)
      .sort((a, b) => a.toPondId.localeCompare(b.toPondId));
    const towardTarget = outbound.find((gate) => gate.toPondId === toPondId && !isGateOpen(gate));
    const anyClosed = outbound.find((gate) => !isGateOpen(gate));
    const closed = towardTarget ?? anyClosed;
    if (closed !== undefined) {
      return { gateId: closed.id, pondId: current, reachablePondId: current };
    }
    for (const gate of openOutboundGates(gates, current)) {
      if (!seen.has(gate.toPondId)) {
        seen.add(gate.toPondId);
        walk.push(gate.toPondId);
      }
    }
  }
  // 起点与目标之间完全没有任何闸门记录
  return { gateId: '', pondId: fromPondId, reachablePondId: fromPondId };
}

/* ------------------------------- 容量占用 ------------------------------- */

export interface CapacityInfo {
  /** 池有效容积（m³） */
  capacityM3: number
  /** 当前卤水体积估算：面积 × 最近水位 */
  occupiedM3: number
  /** 尚余容量（m³） */
  freeM3: number
}

/**
 * 下游池容量：有效容积按池体面积 × 有效水深；
 * 占用 = 面积 × 最近观测水位（无观测按半池水估算）；
 * 再叠加已放行（已排 / 走水中、尚未出卤）且目标为该池的计划占用。
 */
export function capacityOf(
  pond: Pond,
  latestLevelCm: number | null,
  reservations: ScheduleLike[],
): CapacityInfo {
  const capacityM3 = pondVolumeM3(pond.areaM2, pond.depthCm)
  const levelCm = latestLevelCm === null ? pond.depthCm / 2 : latestLevelCm
  const occupiedBase = Math.round(pond.areaM2 * (Math.max(0, levelCm) / 100) * 10) / 10
  const reserved = reservations.reduce((acc, row) => acc + (Number.isFinite(row.volumeM3) ? row.volumeM3 : 0), 0)
  const occupiedM3 = Math.round((occupiedBase + reserved) * 10) / 10
  const freeM3 = Math.round((capacityM3 - occupiedM3) * 10) / 10
  return { capacityM3, occupiedM3, freeM3: Math.max(0, freeM3) }
}

/** capacityOf 只需要计划量字段，避免与 Schedule 类型形成循环引用 */
export interface ScheduleLike {
  volumeM3: number
}

/**
 * 按管护班闸门台账反推闸门池系归属：
 * - 上下游同系 → 该系；
 * - 跨系 → 取上游池所属池系（水流从上游来，按上游管护口径）；
 * - 任一端池已不存在 → 反推不出，返回空串（无主闸，留只读）。
 */
export function inferGateSeriesName(gate: Pick<Gate, 'fromPondId' | 'toPondId'>, ponds: Pond[]): string {
  const from = ponds.find((pond) => pond.id === gate.fromPondId)
  const to = ponds.find((pond) => pond.id === gate.toPondId)
  if (from === undefined || to === undefined) return ''
  if (from.seriesName === to.seriesName) return from.seriesName
  return from.seriesName
}
