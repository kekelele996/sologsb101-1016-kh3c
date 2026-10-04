/**
 * /schedules 走水与出卤编排（调度室台账）
 * 按日期排序、拖拽调整走水先后顺序、逐条推进状态；放行时按管护班当下闸门走向
 * 查上游池 → 目标池，走不通退回待排写明断点闸门，下游容量不足排队写清差量。
 * 消费模型：Schedule、Gate、Assay；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { effectiveVerdict } from '../utils/brine';
import { findOpenRoute, openOutboundGates } from '../utils/topology';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

function emptyDraft(pondId: string, targetPondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    targetPondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', '', 1));

  onMount(() => {
    void pondStore.loadAll();
    // 挂载时按管护班当下闸门走向重检一次未完成计划（其他标签页改闸后的兜底）
    void scheduleStore.revalidateNow();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 待排计划实时按当下闸门走向预判通路（只读提示，真正放行时以联动检查为准） */
  const liveRouteOf = (row: Schedule) =>
    row.targetPondId === ''
      ? null
      : findOpenRoute(pondStore.state.gates, row.pondId, row.targetPondId);

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      const target = pondOf(row.targetPondId);
      if (series !== null && pond?.seriesName !== series && target?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        pondLabel(row.targetPondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = ordered();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      blockedPath: list.filter((row) => row.state === '待排' && row.blockedKind === 'path').length,
      queuedCap: list.filter((row) => row.state === '待排' && row.blockedKind === 'capacity').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  /** 默认目标池：上游池第一道开放出向闸的下游池 */
  const defaultTargetFor = (pondId: string): string => {
    if (pondId === '') return '';
    return openOutboundGates(pondStore.state.gates, pondId)[0]?.toPondId ?? '';
  };

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, defaultTargetFor(pondId), ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      targetPondId: row.targetPondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择上游蒸发池');
      return;
    }
    if (draft.targetPondId === '') {
      scheduleStore.setMessage('请选择目标下游池：放行时按管护班闸门走向查上下游通不通');
      return;
    }
    if (draft.pondId === draft.targetPondId) {
      scheduleStore.setMessage('上游池与目标下游池不能是同一口池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，目标密度 ${row.targetDensity} g/cm³，放行时校验串级`);
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '待排') return '放行（查串级）';
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="断闸退回" value={stats().blockedPath} suffix="条" tone="warning" />
        <StatBadge label="容量排队" value={stats().queuedCap} suffix="条" tone="warning" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
            <p class="mt-0.5 text-xs text-slate-500">放行时按管护班当下走向查上游池到目标池通不通；关闸 / 改派下游后靠旧通路排的计划自动退回重排，已出卤的保留。</p>
          </div>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length < 2}>
            + 新建走水计划
          </button>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池指定目标下游池与走水日期，放行时会按管护班闸门串级校验通路与下游容量；拖拽列表可调整先后顺序。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => {
                const liveRoute = () => liveRouteOf(row);
                return (
                  <li
                    draggable={true}
                    class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                      dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                    }`}
                    onDragStart={() => scheduleStore.setDraggingId(row.id)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOverId(row.id);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDrop(row.id);
                    }}
                  >
                    <span class="grid h-7 w-7 shrink-0 cursor-grab place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                      {index() + 1}
                    </span>
                    <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                      ⠿
                    </span>
                    <div class="min-w-[220px] flex-1">
                      <p class="text-sm font-medium text-slate-800">
                        {pondLabel(row.pondId)}
                        <span class="mx-1 text-brine-500">→</span>
                        <span class="text-brine-700">{row.targetPondId === '' ? '（未指定目标池）' : pondLabel(row.targetPondId)}</span>
                      </p>
                      <p class="text-xs text-slate-500">
                        计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                      </p>
                      <Show when={row.state === '待排'}>
                        <p class="mt-0.5 text-[11px]">
                          <Show
                            when={liveRoute() !== null}
                            fallback={<span class="text-rose-600">当下走向：到目标池暂无可通行通路</span>}
                          >
                            <span class="text-emerald-600">当下走向：通路畅通（{liveRoute()?.gateIds.length ?? 0} 道闸）</span>
                          </Show>
                        </p>
                      </Show>
                      <Show when={(row.state === '已排' || row.state === '走水中') && row.routeGateIds.length > 0}>
                        <p class="mt-0.5 text-[11px] text-slate-400">
                          放行锁定通路：{row.routeGateIds.length} 道闸门
                          {row.state === '走水中' ? '（管护班改闸会即时重检）' : '（管护班改闸会即时退回待排）'}
                        </p>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
                      </p>
                      <p>
                        当前密度{' '}
                        <span class="tabular-nums font-medium text-brine-700">
                          {pondStore.statOf(row.pondId).currentDensity || '—'}
                        </span>
                      </p>
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                      </p>
                      <p>
                        组分判定{' '}
                        <span class="font-medium text-slate-800">
                          {(() => {
                            const list = pondStore.state.assays
                              .filter((item) => item.pondId === row.pondId)
                              .sort((a, b) => a.date.localeCompare(b.date));
                            return list.length === 0 ? '未化验' : effectiveVerdict(list[list.length - 1]);
                          })()}
                        </span>
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1">
                      <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                      <Show when={row.blockedKind === 'path'}>
                        <span class="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">断闸退回</span>
                      </Show>
                      <Show when={row.blockedKind === 'capacity'}>
                        <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                          容量排队 · 差 {row.shortfallM3} m³
                        </span>
                      </Show>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <button
                        class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                        disabled={row.state === '已出卤'}
                        onClick={async () => {
                          if (row.state === '已出卤') return;
                          // store 内部已把断点 / 差量 / 作废原因写入 lastMessage
                          await scheduleStore.advance(row.id);
                        }}
                      >
                        {nextStateLabel(row.state)}
                      </button>
                      <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                        编辑
                      </button>
                      <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                        删除
                      </button>
                    </div>
                    <Show when={row.blockedReason !== ''}>
                      <p class="w-full rounded-md bg-rose-50/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-700">
                        {row.blockedReason}
                      </p>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>上游蒸发池（水源）</span>
            <select
              class={INPUT}
              value={draft.pondId}
              onChange={(event) => {
                const pondId = event.currentTarget.value;
                setDraft('pondId', pondId);
                // 切换上游池时，目标池若与新上游相同则清空
                if (draft.targetPondId === pondId) setDraft('targetPondId', '');
              }}
            >
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标下游池（放行时校验串级）</span>
            <select class={INPUT} value={draft.targetPondId} onChange={(event) => setDraft('targetPondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds.filter((pond) => pond.id !== draft.pondId)}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划走水日期</span>
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>走水状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as ScheduleState)}>
              <For each={SCHEDULE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（越小越先走水）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          保存后点「放行（查串级）」才会按管护班当下闸门走向校验：走不通退回待排并写明断在哪道闸门，下游容量不足先排队写清差量；
          改上下游池会使已排计划的旧通路作废、需重新放行。推进到「已出卤」时会把该池推进到下一蒸发阶段。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')} → {pondLabel(deleting()?.targetPondId ?? '')}」在 {deleting()?.planDate} 的走水计划。
        </p>
      </AppDialog>
    </div>
  );
}
