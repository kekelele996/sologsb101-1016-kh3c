/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 *
 * 调度室排计划只盯池子、不查闸门串级，常排错计划。这里接上管护班的当下走向：
 * - 放行（待排→已排）时按闸门串级查上游池到目标池通不通，不通就退回待排并写明断在哪道闸门；
 * - 管护班关掉通路或改派下游池时，靠它排的计划也退回去等重排（出卤完的留着）；
 * - 开度小幅调整（仍 > 0）不打回计划，关门或改派才断；
 * - 下游池容量不够先排队，写清差量。
 * 闸门串级归管护班，走水计划归调度室：本 store 只读闸门、不改闸门，两边各自记账。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import type { Gate } from '../types/gate';
import type { Pond } from '../types/pond';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  putSchedule,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import { checkCapacity, checkConnectivity } from '../utils/brine';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  // 订阅管护班的闸门串级与池台账：闸门一关 / 一改派，靠它排的计划就要退回待排。
  // 本 store 只读闸门、不改闸门（闸门归管护班），两边各自记账。
  liveQuery(async () => {
    const [gates, ponds] = await Promise.all([db.gates.toArray(), db.ponds.toArray()]);
    return { gates, ponds };
  }).subscribe({
    next: ({ gates, ponds }) => {
      void reevaluateActivePlans(gates, ponds);
    },
    error: (err: unknown) => {
      setState({ error: err instanceof Error ? err.message : '读取闸门串级失败' });
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /**
   * 管护班闸门变动后，重查仍在排的计划（已排 / 走水中）：
   * 通路断了就退回待排并写明断在哪道闸门；已出卤的留着不动。
   * 开度小幅调整（仍 > 0）不算断，只有关门或改派下游池才会触发退回。
   */
  async function reevaluateActivePlans(gates: Gate[], ponds: Pond[]): Promise<void> {
    const schedules = await db.schedules.toArray();
    const active = schedules.filter((row) => row.state === '已排' || row.state === '走水中');
    for (const plan of active) {
      const result = checkConnectivity(plan.pondId, plan.targetPondId, gates, ponds);
      if (!result.connected) {
        await putSchedule({ ...plan, state: '待排', blockedReason: result.reason });
      }
    }
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      targetPondId: draft.targetPondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      blockedReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      targetPondId: draft.targetPondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
    });
    setState('lastMessage', '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  /** 下游池最近水位（用于容量核查）：无观测时按空池估算，避免新池被误判为满 */
  function latestLevelCm(pondId: string): number {
    const list = usePondStore()
      .state.observations.filter((row) => row.pondId === pondId)
      .sort((a, b) => a.date.localeCompare(b.date));
    return list.length > 0 ? list[list.length - 1].levelCm : 0;
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];

    // 放行（待排 → 已排）：按管护班当下走向核查上游池到目标池通不通，
    // 不通就退回待排并写明断在哪道闸门；再查下游池容量够不够，不够先排队写清差量。
    if (existing.state === '待排' && next === '已排') {
      const pondStore = usePondStore();
      const conn = checkConnectivity(existing.pondId, existing.targetPondId, pondStore.state.gates, pondStore.state.ponds);
      if (!conn.connected) {
        await putSchedule({ ...existing, state: '待排', blockedReason: conn.reason });
        setState('lastMessage', `已退回待排：${conn.reason}`);
        return null;
      }
      const target = pondStore.state.ponds.find((pond) => pond.id === existing.targetPondId);
      if (target !== undefined) {
        const cap = checkCapacity(target, existing.volumeM3, latestLevelCm(target.id));
        if (!cap.sufficient) {
          const reason = `下游池 ${target.code} 容量不足：计划 ${existing.volumeM3} m³，剩余 ${cap.remainingM3} m³，差量 ${cap.deficitM3} m³`;
          await putSchedule({ ...existing, state: '待排', blockedReason: reason });
          setState('lastMessage', `已排队：${reason}`);
          return null;
        }
      }
    }

    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    // 放行成功：清掉之前的断开 / 排队原因
    if (existing.blockedReason !== '') {
      await putSchedule({ ...existing, blockedReason: '' });
    }
    setState(
      'lastMessage',
      next === '已出卤'
        ? `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`
        : `状态已推进为「${next}」`,
    );
    return next;
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
