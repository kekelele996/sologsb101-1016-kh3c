/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 *
 * 台账边界：本 store 是调度室侧入口，只读写走水计划；闸门串级由管护班侧维护。
 * 放行/开始走水走 utils/coordination 的串级与容量检查；管护班改闸后自动重检，
 * 把沿作废旧通路排的计划退回待排（已出卤的保留不动）。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  onGateChanged,
  putSchedule,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import {
  dispatchSchedule,
  revalidateActiveSchedules,
  startFlowOrRequeue,
  type RevalidationResult,
} from '../utils/coordination';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string
  seriesName: string | 'all'
  state: ScheduleState | 'all'
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[]
  loading: boolean
  error: string
  lastMessage: string
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

  /**
   * 管护班结构性改闸（关闸 / 改派下游 / 拆闸 / 删池）后，
   * 调度侧自动重检未完成计划：沿旧通路走不通的退回待排重排。
   * 小幅调开度不影响旧通路，coordination 内部不会打回。
   */
  onGateChanged(() => {
    void revalidateActiveSchedules()
      .then((result: RevalidationResult) => {
        if (result.resetCount > 0) {
          setState('lastMessage', `管护班闸门走向已变更：${result.resetCount} 条沿旧通路排的计划已退回待排重排`);
        }
      })
      .catch(() => undefined)
  });

  /** 页面挂载时也重检一次（其他标签页 / 旧版本数据升级后的兜底） */
  async function revalidateNow(): Promise<RevalidationResult> {
    try {
      return await revalidateActiveSchedules();
    } catch (err) {
      setState('lastMessage', err instanceof Error ? err.message : '调度侧重检失败');
      return { resetCount: 0, items: [] };
    }
  }

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
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
      routeGateIds: [],
      routePondIds: [],
      blockedKind: '',
      blockedReason: '',
      shortfallM3: 0,
      releasedAt: '',
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
    // 上游池 / 目标池一旦改了，旧通路快照与排队/打回标记一并作废，需要重新放行
    const routeDirty = existing.pondId !== draft.pondId || existing.targetPondId !== draft.targetPondId;
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      targetPondId: draft.targetPondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: routeDirty && (draft.state === '已排' || draft.state === '走水中') ? '待排' : draft.state,
      orderIndex: draft.orderIndex,
      routeGateIds: routeDirty ? [] : existing.routeGateIds,
      routePondIds: routeDirty ? [] : existing.routePondIds,
      blockedKind: routeDirty ? '' : existing.blockedKind,
      blockedReason: routeDirty ? '' : existing.blockedReason,
      shortfallM3: routeDirty ? 0 : existing.shortfallM3,
      releasedAt: routeDirty ? '' : existing.releasedAt,
    });
    setState('lastMessage', routeDirty ? '上下游池已变更，旧通路作废，请重新放行' : '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  /**
   * 调度室放行 / 推进：
   * - 待排 → 已排：按管护班当下闸门走向查上游池 → 目标池，走不通退回待排写明断点；
   *   下游池容量不够先排队，写清差量；通过则锁定通路快照。
   * - 已排 → 走水中：再次按旧通路快照复核，防止沿作废旧通路走水。
   * - 走水中 → 已出卤：回写池阶段与实际密度。
   */
  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];

    if (next === '已排') {
      const check = await dispatchSchedule(scheduleId);
      if (!check.ok) {
        setState('lastMessage', check.reason);
        return null;
      }
      setState('lastMessage', `放行通过：已按管护班当下走向锁定 ${check.route?.gateIds.length ?? 0} 道闸门的通路`);
      return '已排';
    }

    if (next === '走水中') {
      const result = await startFlowOrRequeue(scheduleId);
      if (!result.ok) {
        setState('lastMessage', result.reason);
        return null;
      }
      setState('lastMessage', '旧通路复核通过，计划已开始走水');
      return '走水中';
    }

    // 已出卤：回写池阶段与实际密度
    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState(
      'lastMessage',
      `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`,
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
    revalidateNow,
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
