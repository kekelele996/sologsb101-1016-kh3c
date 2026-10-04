/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：打通调度室 ⨝ 管护班——闸门补池系归属（按上下游池反推，无主留只读），
 *       走水计划补目标池、通路快照、打回/排队原因与容量差量
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import { estimateEvapMm } from './brine';
import { inferGateSeriesName, findOpenRoute } from './topology';
import { nowIso } from './id';
import { withSideRetry } from './retry';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** 管护班结构性改闸后要通知调度侧重检的钩子（由 scheduleStore 注册） */
type GateChangeListener = () => void | Promise<void>;
const gateChangeListeners = new Set<GateChangeListener>();

export function onGateChanged(listener: GateChangeListener): () => void {
  gateChangeListeners.add(listener);
  return () => gateChangeListeners.delete(listener);
}

async function emitGateChanged(): Promise<void> {
  await Promise.all(
    Array.from(gateChangeListeners).map((listener) =>
      Promise.resolve()
        .then(() => listener())
        .catch(() => undefined),
    ),
  )
}

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：调度室 ⨝ 管护班联动字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct, seriesName',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, targetPondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        const ponds = (await tx.table('ponds').toArray()) as Pond[];
        const gates = (await tx.table('gates').toArray()) as Gate[];

        // 迁移 5：旧闸门缺池系归属，按上下游池反推补上；反推不出（无主）的留只读
        await tx.table('gates').toCollection().modify((row: Record<string, unknown>) => {
          const gateRef = {
            fromPondId: typeof row.fromPondId === 'string' ? row.fromPondId : '',
            toPondId: typeof row.toPondId === 'string' ? row.toPondId : '',
          };
          const seriesName = inferGateSeriesName(gateRef, ponds);
          row.seriesName = seriesName;
          row.ownerInferred = true;
        });

        // 迁移 6：走水计划补目标池（按唯一开放下游反推）、通路快照与打回/排队字段。
        // 旧数据放行时没查过闸门串级：统一按当下走向复核，走不通的退回待排并写明断点。
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.targetPondId !== 'string') {
            const pondId = typeof row.pondId === 'string' ? row.pondId : '';
            const outbound = gates.filter(
              (gate) => gate.fromPondId === pondId && gate.state !== '关闭' && gate.openingPct > 0,
            );
            const uniqueTo = new Set(outbound.map((gate) => gate.toPondId));
            row.targetPondId = uniqueTo.size === 1 ? outbound[0].toPondId : '';
          }
          if (!Array.isArray(row.routeGateIds)) row.routeGateIds = [];
          if (!Array.isArray(row.routePondIds)) row.routePondIds = [];
          if (typeof row.blockedKind !== 'string') row.blockedKind = '';
          if (typeof row.blockedReason !== 'string') row.blockedReason = '';
          if (typeof row.shortfallM3 !== 'number') row.shortfallM3 = 0;
          if (typeof row.releasedAt !== 'string') row.releasedAt = '';

          const state = row.state as ScheduleState;
          if ((state === '已排' || state === '走水中') && typeof row.targetPondId === 'string' && row.targetPondId !== '') {
            const pondId = typeof row.pondId === 'string' ? row.pondId : '';
            const route = findOpenRoute(gates, pondId, row.targetPondId)
            if (route !== null) {
              row.routeGateIds = route.gateIds;
              row.routePondIds = route.pondIds;
            } else {
              row.state = '待排'
              row.blockedKind = 'path'
              row.blockedReason =
                '升级复核：按管护班当下闸门走向，上游池到目标池走不通（旧计划放行时未查串级），退回待排重排'
              row.shortfallM3 = 0
              row.routeGateIds = []
              row.routePondIds = []
              row.releasedAt = ''
            }
          }
        });
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await withSideRetry(
    () => db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION }),
    { side: '管护班闸门侧' },
  );
}

/**
 * 删除蒸发池，并级联清理相关闸门、观测、化验（管护班侧台账）；
 * 走水计划属调度室台账，不由本操作代删——由调度侧重检把受影响计划退回待排。
 */
export async function removePond(id: string): Promise<void> {
  await withSideRetry(async () => {
    await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    });
  }, { side: '管护班闸门侧' });
  // 池子/闸门结构性变化后通知调度室重检
  await emitGateChanged();
}

/* -------------------------------- 闸门（管护班侧） -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

/**
 * 管护班保存闸门（新建 / 编辑）。
 * 无主闸（seriesName 为空且归属反推不出）只允许只读展示，拒绝保存。
 */
export async function putGate(row: Gate, ponds?: Pond[]): Promise<void> {
  await withSideRetry(async () => {
    let seriesName = row.seriesName;
    if (seriesName === '') {
      const poolList = ponds ?? (await db.ponds.toArray());
      seriesName = inferGateSeriesName(row, poolList);
      if (seriesName === '') {
        throw new Error('该闸门上下游池缺失，无法反推池系归属（无主闸只读），不能保存');
      }
    }
    await db.gates.put({ ...row, seriesName, updatedAt: nowIso(), revision: ROW_REVISION });
  }, { side: '管护班闸门侧' });
  // 闸门保存可能改了走向/开度，通知调度室按旧通路快照重检（小幅调开度不会打回计划）
  await emitGateChanged();
}

/**
 * 就地调整开度：同步推导闸门状态。
 * 小幅调开度（闸仍开着）不属于结构性变更，计划不会因此被打回；
 * 只有调到 0%（关闭）才算关断通路——此时仍触发一次调度侧重检。
 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await withSideRetry(
    () => db.gates.update(id, { openingPct, state, updatedAt: nowIso() }),
    { side: '管护班闸门侧' },
  );
  if (state === '关闭' || openingPct <= 0) {
    await emitGateChanged();
  }
}

export async function removeGate(id: string): Promise<void> {
  await withSideRetry(() => db.gates.delete(id), { side: '管护班闸门侧' });
  // 拆闸属结构性变更：靠它排的计划由调度侧重检后退回待排
  await emitGateChanged();
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  return withSideRetry(async () => {
    const evapMm =
      Number.isFinite(row.evapMm) && row.evapMm > 0
        ? row.evapMm
        : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
    const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
    const next: Observation = {
      ...row,
      id: existing === undefined ? row.id : existing.id,
      evapMm,
      createdAt: existing === undefined ? row.createdAt : existing.createdAt,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await db.observations.put(next);
    return next;
  }, { side: '管护班闸门侧' });
}

export async function removeObservation(id: string): Promise<void> {
  await withSideRetry(() => db.observations.delete(id), { side: '管护班闸门侧' });
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await withSideRetry(
    () => db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION }),
    { side: '管护班闸门侧' },
  );
}

export async function removeAssay(id: string): Promise<void> {
  await withSideRetry(() => db.assays.delete(id), { side: '管护班闸门侧' });
}

/* ------------------------------ 走水编排（调度室侧） ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await withSideRetry(
    () => db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION }),
    { side: '调度室走水侧' },
  );
}

export async function removeSchedule(id: string): Promise<void> {
  await withSideRetry(() => db.schedules.delete(id), { side: '调度室走水侧' });
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await withSideRetry(async () => {
    await db.transaction('rw', db.schedules, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
      }
    });
  }, { side: '调度室走水侧' });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 * 注意：这里写 ponds / observations 是出卤动作的业务回写（调度室推进晒程的既有规则），
 * 与「闸门串级台账管护班独占」的边界不冲突。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await withSideRetry(async () => {
    await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
      const schedule = await db.schedules.get(scheduleId);
      if (!schedule) return;
      await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
      const pond = await db.ponds.get(schedule.pondId);
      if (!pond) return;
      const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
      await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
      const list = await db.observations.where('pondId').equals(pond.id).toArray();
      if (list.length === 0) return;
      const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
      const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
      await db.observations.update(latest.id, {
        densityGcm3: density,
        evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
        updatedAt: nowIso(),
      });
    });
  }, { side: '调度室走水侧' });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await withSideRetry(
    () => db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() }),
    { side: '调度室走水侧' },
  );
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  assays: Assay[]
  schedules: Schedule[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
  ]);
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), ponds, gates, observations, assays, schedules };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
  await emitGateChanged();
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
  });
  await seedDatabase();
  await emitGateChanged();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
  ]);
  return { ponds, gates, observations, assays, schedules };
}
