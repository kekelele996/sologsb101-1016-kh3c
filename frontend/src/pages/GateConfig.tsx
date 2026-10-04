/**
 * /gates 串级走向与闸门配置（盐田管护班台账）
 * 按池系渲染串级拓扑，开度就地编辑；开度调整后重算下游预计进水量。
 * 消费模型：Gate、Pond、Observation；复用组件：<FilterBar>、<StageTag>、<EmptyPanel>、<StatBadge>
 *
 * 边界：本页只管护闸门；关闸 / 改派下游 / 删闸后由调度室侧重检走水计划
 * （db 层 emitGateChanged → coordination.revalidateActiveSchedules），
 * 本页不直接改任何走水计划。小幅调开度不打回计划。
 */
import { For, Show, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { GATE_STATE_OPTIONS, type Gate, type GateDraft, type GateState } from '../types/gate';
import { estimateInflowM3, gateFlowAreaM2, stateFromOpening } from '../utils/brine';
import { putGate, removeGate, updateGateOpening } from '../utils/db';
import { inferGateSeriesName } from '../utils/topology';
import { revalidateActiveSchedules } from '../utils/coordination';
import { nowIso, uuid } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const DEFAULT_DRAFT: GateDraft = {
  fromPondId: '',
  toPondId: '',
  openingPct: 50,
  widthCm: 120,
  state: '半开',
  seriesName: '',
  note: '',
};

/** 无主闸：升级时按上下游池反推不出归属（端池缺失），只读展示 */
const isOrphanGate = (gate: Gate): boolean => gate.seriesName === '';

export default function GateConfig() {
  const store = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deletingGate, setDeletingGate] = createSignal<Gate | null>(null);
  const [message, setMessage] = createSignal('');
  const [draft, setDraft] = createStore<GateDraft>({ ...DEFAULT_DRAFT });

  onMount(() => {
    void store.loadAll();
  });

  const pondOf = (pondId: string) => store.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 上游池最近水位，用于估算过流 */
  const upstreamLevel = (pondId: string): number => {
    const list = store.state.observations
      .filter((row) => row.pondId === pondId)
      .sort((a, b) => a.date.localeCompare(b.date));
    return list.length === 0 ? 40 : list[list.length - 1].levelCm;
  };

  const gatesOfSeries = (): Gate[] => {
    const series = store.state.currentSeries;
    return store.state.gates.filter((gate) => {
      const from = pondOf(gate.fromPondId);
      const to = pondOf(gate.toPondId);
      if (series === null) return true;
      return gate.seriesName === series || from?.seriesName === series || to?.seriesName === series;
    });
  };

  const totalInflow = (): number =>
    gatesOfSeries().reduce((acc, gate) => acc + estimateInflowM3(gate, upstreamLevel(gate.fromPondId)), 0);

  const openCreate = (): void => {
    const ponds = store.pondsOfSeries(store.state.currentSeries);
    setEditingId(null);
    setDraft({
      ...DEFAULT_DRAFT,
      fromPondId: ponds[0]?.id ?? '',
      toPondId: ponds[1]?.id ?? '',
    });
    setDialogOpen(true);
  };

  const openEdit = (gate: Gate): void => {
    if (isOrphanGate(gate)) return;
    setEditingId(gate.id);
    setDraft({
      fromPondId: gate.fromPondId,
      toPondId: gate.toPondId,
      openingPct: gate.openingPct,
      widthCm: gate.widthCm,
      state: gate.state,
      seriesName: gate.seriesName,
      note: gate.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.fromPondId === '' || draft.toPondId === '') {
      setMessage('请选择上游池与下游池');
      return;
    }
    if (draft.fromPondId === draft.toPondId) {
      setMessage('上游池与下游池不能是同一口池');
      return;
    }
    // 归属默认按上下游池反推：同系取该系，跨系取上游系
    const inferred = inferGateSeriesName(
      { fromPondId: draft.fromPondId, toPondId: draft.toPondId },
      store.state.ponds,
    );
    if (inferred === '') {
      setMessage('上游池或下游池不存在，无法确定池系归属（无主闸只读），不能保存');
      return;
    }
    const payload: GateDraft = { ...draft, state: stateFromOpening(draft.openingPct), seriesName: draft.seriesName || inferred };
    const wasStructuralChange =
      editingId() !== null &&
      (() => {
        const prev = store.state.gates.find((gate) => gate.id === editingId());
        return prev !== undefined && (prev.fromPondId !== payload.fromPondId || prev.toPondId !== payload.toPondId);
      })();
    try {
      if (editingId() === null) {
        const stamp = nowIso();
        await putGate({
          id: uuid('gate'),
          ...payload,
          ownerInferred: false,
          createdAt: stamp,
          updatedAt: stamp,
          revision: 3,
        });
        setMessage(`已新建闸门：${pondLabel(payload.fromPondId)} → ${pondLabel(payload.toPondId)}（归属 ${payload.seriesName}）`);
      } else {
        const existing = store.state.gates.find((gate) => gate.id === editingId());
        if (existing === undefined) return;
        await putGate({ ...existing, ...payload, ownerInferred: existing.ownerInferred });
        // 改派下游池属于结构性变更：立即给出调度侧打回结果（db 层钩子也会兜底重检一次）
        if (wasStructuralChange) {
          const result = await revalidateActiveSchedules();
          setMessage(
            result.resetCount > 0
              ? `下游池已改派：${result.resetCount} 条靠旧通路排的走水计划已退回调度室待排重排`
              : '闸门走向已更新，当前没有受影响的走水计划',
          );
        } else {
          setMessage('闸门配置已更新');
        }
      }
      setDialogOpen(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '闸门保存失败');
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const gate = deletingGate();
    if (gate === null) return;
    try {
      await removeGate(gate.id);
      const result = await revalidateActiveSchedules();
      setDeletingGate(null);
      setMessage(
        result.resetCount > 0
          ? `闸门已拆除：${result.resetCount} 条靠该通路排的走水计划已退回调度室待排重排`
          : '闸门已删除',
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '闸门删除失败');
    }
  };

  const adjustOpening = async (gate: Gate, openingPct: number): Promise<void> => {
    if (isOrphanGate(gate)) {
      setMessage('无主闸为只读闸门，不能调整开度');
      return;
    }
    const clamped = Math.max(0, Math.min(100, Math.round(openingPct)));
    if (clamped === gate.openingPct) return;
    try {
      await updateGateOpening(gate.id, clamped, stateFromOpening(clamped));
      if (clamped <= 0) {
        // 关闭通路：靠它排的计划退回待排；小幅调开度不会打回任何计划
        const result = await revalidateActiveSchedules();
        setMessage(
          result.resetCount > 0
            ? `已关闭 ${pondLabel(gate.fromPondId)} → ${pondLabel(gate.toPondId)}：${result.resetCount} 条走水计划退回待排`
            : `已关闭闸门「${pondLabel(gate.fromPondId)} → ${pondLabel(gate.toPondId)}」，当前没有受影响的走水计划`,
        );
      } else {
        setMessage(`已把 ${pondLabel(gate.fromPondId)} → ${pondLabel(gate.toPondId)} 的开度调整为 ${clamped}%（小幅调开度不影响已排计划）`);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '开度调整失败');
    }
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="闸门总数" value={store.state.gates.length} suffix="条" tone="primary" />
        <StatBadge label="当前池系闸门" value={gatesOfSeries().length} suffix="条" tone="info" />
        <StatBadge
          label="全开闸门"
          value={store.state.gates.filter((gate) => gate.state === '全开').length}
          suffix="条"
          tone="success"
        />
        <StatBadge
          label="关闭闸门"
          value={store.state.gates.filter((gate) => gate.state === '关闭').length}
          suffix="条"
          tone="warning"
        />
        <StatBadge
          label="无主只读闸"
          value={store.state.gates.filter((gate) => isOrphanGate(gate)).length}
          suffix="条"
          tone="warning"
        />
        <StatBadge
          label="下游预计进水合计"
          value={Math.round(totalInflow() * 10) / 10}
          suffix="m³/d"
          tone="info"
          hint="按各闸门开度、口宽与上游最近水位用简易堰流公式估算"
        />
      </div>

      <Show when={message() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {message()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">串级走向与闸门配置</h2>
            <p class="mt-0.5 text-xs text-slate-500">闸门串级归管护班维护；关闸 / 改派下游 / 拆闸后，调度室靠该通路排的计划自动退回待排，已出卤的保留。</p>
          </div>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={store.state.ponds.length < 2}>
            + 新建闸门
          </button>
        </header>

        <FilterBar
          keyword=""
          onKeyword={() => undefined}
          fields={[{ key: 'series', label: '池系', options: store.seriesOptions() }]}
          values={{ series: store.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') store.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => store.setCurrentSeries(store.seriesOptions()[0] ?? null)}
          resultText={`命中 ${gatesOfSeries().length} / ${store.state.gates.length} 条`}
        />

        <Show when={store.state.ready && store.state.gates.length === 0}>
          <EmptyPanel
            title="还没有闸门串级"
            description="新建闸门把上游池与下游池连接起来，配置开度后即可看到下游预计进水量的即时变化。"
            actionText="新建第一条闸门"
            onAction={openCreate}
          />
        </Show>

        <Show when={store.state.gates.length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1200px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">串级走向</th>
                  <th class="px-3 py-2">池系归属</th>
                  <th class="px-3 py-2">上游阶段</th>
                  <th class="px-3 py-2">下游阶段</th>
                  <th class="px-3 py-2 w-64">开度（就地编辑）</th>
                  <th class="px-3 py-2">闸门状态</th>
                  <th class="px-3 py-2">过流面积</th>
                  <th class="px-3 py-2">下游预计进水量</th>
                  <th class="px-3 py-2">备注</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={gatesOfSeries()}>
                  {(gate) => (
                    <tr class={`border-b border-slate-100 align-middle hover:bg-slate-50/60 ${isOrphanGate(gate) ? 'bg-rose-50/40' : ''}`}>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-1.5 text-[13px]">
                          <span class="font-medium text-slate-800">{pondLabel(gate.fromPondId)}</span>
                          <span class="text-brine-600">→</span>
                          <span class="font-medium text-slate-800">{pondLabel(gate.toPondId)}</span>
                        </div>
                      </td>
                      <td class="px-3 py-2.5">
                        <Show
                          when={!isOrphanGate(gate)}
                          fallback={<span class="rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700" title="旧数据缺池系归属，按上下游池也反推不出，留只读">无主 · 只读</span>}
                        >
                          <span class="text-xs text-slate-600">
                            {gate.seriesName}
                            <Show when={gate.ownerInferred}>
                              <span class="ml-1 text-[11px] text-slate-400" title="升级时按上下游池反推补上的归属">（反推）</span>
                            </Show>
                          </span>
                        </Show>
                      </td>
                      <td class="px-3 py-2.5">
                        <StageTag stage={pondOf(gate.fromPondId)?.stage ?? null} size="sm" />
                      </td>
                      <td class="px-3 py-2.5">
                        <StageTag stage={pondOf(gate.toPondId)?.stage ?? null} size="sm" />
                      </td>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-2">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={gate.openingPct}
                            disabled={isOrphanGate(gate)}
                            class="h-1.5 flex-1 accent-brine-600 disabled:opacity-40"
                            onChange={(event) => void adjustOpening(gate, Number(event.currentTarget.value))}
                          />
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={gate.openingPct}
                            disabled={isOrphanGate(gate)}
                            class="w-16 rounded border border-slate-300 px-1.5 py-1 text-xs tabular-nums outline-none focus:border-brine-500 disabled:cursor-not-allowed disabled:opacity-40"
                            onChange={(event) => void adjustOpening(gate, Number(event.currentTarget.value))}
                          />
                          <span class="text-xs text-slate-400">%</span>
                        </div>
                      </td>
                      <td class="px-3 py-2.5">
                        <span
                          class={`rounded border px-1.5 py-0.5 text-[11px] ${
                            gate.state === '全开'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                              : gate.state === '关闭'
                                ? 'border-slate-300 bg-slate-100 text-slate-500'
                                : 'border-amber-300 bg-amber-50 text-amber-700'
                          }`}
                        >
                          {gate.state}
                        </span>
                      </td>
                      <td class="px-3 py-2.5 tabular-nums text-slate-600">{gateFlowAreaM2(gate)} ㎡</td>
                      <td class="px-3 py-2.5 tabular-nums font-medium text-brine-700">
                        {estimateInflowM3(gate, upstreamLevel(gate.fromPondId))} m³/d
                        <span class="ml-1 text-[11px] text-slate-400">
                          （上游水位 {upstreamLevel(gate.fromPondId)} cm）
                        </span>
                      </td>
                      <td class="px-3 py-2.5 text-xs text-slate-500">{gate.note === '' ? '—' : gate.note}</td>
                      <td class="px-3 py-2.5">
                        <div class="flex gap-2">
                          <button
                            class="text-xs text-brine-700 hover:underline disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
                            disabled={isOrphanGate(gate)}
                            title={isOrphanGate(gate) ? '无主闸只读，不能编辑' : ''}
                            onClick={() => openEdit(gate)}
                          >
                            编辑
                          </button>
                          <button
                            class="text-xs text-rose-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
                            disabled={isOrphanGate(gate)}
                            title={isOrphanGate(gate) ? '无主闸只读，不能删除' : ''}
                            onClick={() => setDeletingGate(gate)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={store.state.gates.length > 0 && gatesOfSeries().length === 0}>
          <EmptyPanel
            title="当前池系没有闸门"
            description="可以切换池系，或为该池系新建一条串级闸门。"
            actionText="新建闸门"
            onAction={openCreate}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建闸门' : '编辑闸门'}
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
            <span>上游池</span>
            <select
              class={INPUT}
              value={draft.fromPondId}
              onChange={(event) => setDraft('fromPondId', event.currentTarget.value)}
            >
              <option value="">请选择</option>
              <For each={store.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>下游池</span>
            <select class={INPUT} value={draft.toPondId} onChange={(event) => setDraft('toPondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={store.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>池系归属</span>
            <select class={INPUT} value={draft.seriesName} onChange={(event) => setDraft('seriesName', event.currentTarget.value)}>
              <option value="">按上下游池自动反推</option>
              <For each={store.seriesOptions()}>
                {(series) => <option value={series}>{series}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>开度（%）</span>
            <input
              type="number"
              min="0"
              max="100"
              class={INPUT}
              value={draft.openingPct}
              onInput={(event) => setDraft('openingPct', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>口宽（cm）</span>
            <input
              type="number"
              min="10"
              max="600"
              class={INPUT}
              value={draft.widthCm}
              onInput={(event) => setDraft('widthCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>闸门状态</span>
            <select
              class={INPUT}
              value={draft.state}
              onChange={(event) => setDraft('state', event.currentTarget.value as GateState)}
            >
              <For each={GATE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          按开度自动推导的闸门状态为「{stateFromOpening(draft.openingPct)}」，保存时以开度推导结果为准；
          关闭 / 改派下游 / 删除会让靠旧通路排的走水计划退回调度室待排，小幅调整开度不会打回计划。
        </p>
      </AppDialog>

      <AppDialog
        open={deletingGate() !== null}
        title="确认删除闸门？"
        width="max-w-lg"
        onClose={() => setDeletingGate(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingGate(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除串级「{pondLabel(deletingGate()?.fromPondId ?? '')} → {pondLabel(deletingGate()?.toPondId ?? '')}」，
          删除后下游池将失去该进水通道，靠这条通路排的未完成走水计划会自动退回调度室待排重排（已出卤的保留）。
        </p>
      </AppDialog>
    </div>
  );
}
