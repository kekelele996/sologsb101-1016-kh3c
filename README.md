# 盐湖蒸发池卤水晒程编排台（sologsb101-1016）

面向盐湖提锂 / 提钾车间的晒程调度员：把盐田内每口蒸发池的卤水走向按串级关系编排，
逐日跟踪密度、温度与离子组分变化，估算蒸发量，编排走水与出卤时点。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22816**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbbrinepond` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | SolidJS 1.9 | 细粒度响应式，无虚拟 DOM |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22816） |
| 路由 | @solidjs/router 0.15 | `Router root={App}` 布局路由，全部路径支持深链刷新 |
| 状态管理 | Solid 原生能力 | `createStore`（pondStore / scheduleStore）+ `createSignal`（observationStore），**不使用 Pinia / Zustand** |
| UI | Tailwind CSS 3.4 | 全部界面手写 Tailwind，**不使用 Element Plus / Ant Design / Vue / React** |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbbrinepond`，`v1 → v2` 新增 `evapMm`、`v2 → v3` 打通管护班闸门与调度室走水计划 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1016/
├── README.md
├── docker-compose.yml          # name: gbbrinepond，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── index.tsx           # 入口：render + 初始化数据库
        ├── App.tsx             # 外壳：品牌栏 + 侧边导航 + 内容区（Router root 布局）
        ├── styles/main.css     # @tailwind 指令 + 全局样式
        ├── types/              # pond.ts gate.ts observation.ts assay.ts schedule.ts
        ├── stores/             # pondStore.ts observationStore.ts scheduleStore.ts
        ├── components/common/  # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx AppDialog.tsx
        ├── hooks/              # useEvaporation.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面
        ├── router/index.tsx    # AppRouter + ROUTES 常量 + NAV_ITEMS
        └── utils/              # brine.ts db.ts export.ts seed.ts id.ts topology.ts coordination.ts retry.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/ponds` | `pages/PondList.tsx` | 蒸发池与池系台账：新建/编辑/级联删除、按池系与阶段筛选，卡片回显当期密度与最近观测日期 |
| `/gates` | `pages/GateConfig.tsx` | 串级走向与闸门配置：拓扑列表 + 开度就地编辑（滑块/数字），实时重算下游预计进水量 |
| `/observations` | `pages/ObservationEntry.tsx` | 卤水日观测录入台：单条 + 批量粘贴录入，同池同日覆盖写入，蒸发量按经验公式自动估算 |
| `/assays` | `pages/AssayEntry.tsx` | 离子组分分析：Li⁺/K⁺/Mg²⁺/Na⁺ 录入、自动达标判定（可人工覆盖）、SVG 组分曲线 |
| `/schedules` | `pages/ScheduleBoard.tsx` | 走水与出卤编排：按日期排序、HTML5 拖拽调整先后顺序、逐条推进状态、出卤回写池阶段 |
| `/export` | `pages/ExportView.tsx` | 晒程进度汇总、JSON 结构版本查看与导入导出、CSV 汇总、重置演示数据 |

`/` 重定向到 `/ponds`，未匹配路径统一回落到 `/ponds`。
**全部路由支持直接深链**：把 `http://localhost:22816/schedules` 或 `http://localhost:22816/assays` 直接粘贴到地址栏刷新即可打开；
筛选条件还会同步到 URL query，带筛选的链接可以直接分享。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbbrinepond`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`
  * `db.version(1)`：建立全部表与 **`pondId+date` 复合索引**（`observations`、`assays`）；
  * `db.version(2)`：**新增 `evapMm` 字段**并写入真实升级迁移逻辑 ——
    `.upgrade()` 里对 `observations` 逐行检查，缺失或非法时按密度/温度/水位/风力用经验公式回填默认值；
    同时补齐 `revision` / `createdAt` / `updatedAt`、`assays.verdictManual`、`schedules.orderIndex`。
  * `db.version(3)`：**打通盐田管护班（闸门串级台账）与调度室（走水计划台账）两边各自记账的联动** ——
    闸门补 `seriesName` 池系归属（旧数据按上下游池反推：同系取该系、跨系取上游系，反推不出的**无主闸留只读**）；
    走水计划补 `targetPondId`（按唯一开放下游反推）、放行通路快照 `routeGateIds/routePondIds`、
    打回/排队标记 `blockedKind/blockedReason`、容量差量 `shortfallM3`、`releasedAt`；
    已排 / 走水中的旧计划按当下走向复核，走不通的退回待排。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `ponds` | id | code, seriesName, stage, status, createdAt, updatedAt |
  | `gates` | id | fromPondId, toPondId, state, openingPct, **seriesName（v3 池系归属）** |
  | `observations` | id | pondId, date, **[pondId+date]**, densityGcm3, evapMm |
  | `assays` | id | pondId, date, **[pondId+date]**, verdict, verdictManual |
  | `schedules` | id | pondId, **targetPondId**, planDate, state, orderIndex |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `ponds` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **蒸发池 → 闸门串级 / 卤水日观测 → 离子组分分析 → 走水编排** 三层互相引用：
  * 5 口蒸发池跨 2 个池系（北部一系 / 南部二系），覆盖钠盐 / 钾盐 / 锂盐三个阶段；
  * 4 条闸门串级（北-01→北-02→北-03、南-04→南-05、跨池系备用闸），1 条关闭用于验证开度联动；
  * 16 条卤水日观测（每池 2–4 条，密度随日期递增，`evapMm` 由经验公式生成）；
  * 6 条离子组分分析（覆盖达标 / 接近 / 未达标，其中 1 条为人工覆盖判定）；
  * 6 条走水编排（覆盖放行成功 / 断闸退回 / 容量排队 / 走水中 / 已出卤五种情形）。
  * 固定 id 如 `pond-north-01`、`pond-south-04` 可直接用于验证与二次开发。
* **其他本地数据**：`localStorage` 仅保存「最近选中的池系」这一界面偏好，不存业务数据。
* 删除蒸发池会**级联清理管护侧台账**（相关闸门、观测、化验在同一 Dexie 事务内完成）；
  走水计划属调度室台账不被代删，由调度侧重检把受影响计划退回待排并写明原因。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22816
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/brine.ts`）

* **密度—温度修正**：`density(25) = density(t) + 0.00035 × (t − 25)`，统一折算到 25 ℃ 便于横向比较。
* **蒸发量经验公式**：温度、风力越大蒸发越强，卤水密度越高蒸发越弱，水位低于 10 cm 时按比例折减：
  `evapMm = 5.5 × tempFactor × windFactor × brineFactor × levelFactor`。
* **密度增速**：`(末次密度 − 首次密度) / 天数`，并按当前增速外推预计密度。
* **达标判定阈值**：Li⁺ ≥ 1.0 g/L 且 K⁺ ≥ 20 g/L 为「达标」；任一项落在接近区间（Li⁺ ≥ 0.6、K⁺ ≥ 12）为「接近」，其余「未达标」。
  判定达标的池自动进入**出卤候选**；人工覆盖只改写判定标注，原始化验数值保持不变。
* **闸门过流估算**：`1.7 × 过流面积 × √水头 × 开度`，用于开度调整后的下游进水量即时反馈；开度变化会同步推导闸门状态（关闭 / 半开 / 全开）。
* **出卤回写**：走水状态推进到「已出卤」时，蒸发池阶段自动推进（钠盐→钾盐→锂盐），并把最新一次观测的密度回写为实际密度。

---

## 八、管护班 ⨝ 调度室 两侧联动（`src/utils/topology.ts` / `coordination.ts` / `retry.ts`）

闸门串级归**盐田管护班**（`/gates`），走水计划归**调度室**（`/schedules`），两边各自记账、互不代改：
联动服务只读闸门台账、只写计划台账，没有任何反向写闸门的入口。

* **放行查串级**：调度室「待排 → 已排」放行时，按管护班**当下**闸门走向用 BFS 查上游池 → 目标池
  （只走未关闭且开度 > 0 的闸门）。走不通**退回待排**，写明断在哪道闸门（`findBlockage`：
  拆除闸写闸门号、关闭闸写开度、中间无出口写断点池）；通过则把 `gateIds/pondIds` 通路快照锁进计划，
  防止日后沿作废的旧通路走水。
* **容量排队**：下游池尚余容量（有效容积 − 当前卤水体积 − 已放行同目标计划的占用量）不够时先排队，
  状态留在待排，`shortfallM3` 写清差量，原因写「尚余 X / 本计划 Y / 差 Z m³」，容量腾出后重新放行。
* **改闸退回**：管护班关掉通路、改派下游池或拆闸后，调度侧自动重检所有「已排 / 走水中」计划，
  沿旧通路快照逐闸核对（id、上下游、开闭），再按当下走向确认仍能抵达目标池，断了就退回待排重排；
  **已出卤的历史计划保留不动**。`db` 层闸门结构性变更通过 `onGateChanged` 钩子通知调度侧，
  `/gates` 操作后与 `/schedules` 挂载时各兜底重检一次。
* **小幅调开度不打回**：只改开度且闸门仍开放时旧通路仍成立，不产生任何退回；只有调到 0%（关断）
  才触发重检。
* **开始走水再复核**：「已排 → 走水中」前再按当下闸门复核一次旧通路，作废则退回待排，不让计划沿旧通路真走水。
* **本侧重试**：管护侧（闸门/观测/化验/池）与调度侧（走水计划）的 IndexedDB 写入分别经
  `withSideRetry` 指数退避重试（120ms、240ms，共 3 次），哪侧保存失败只重试本侧，错误信息带侧别。
* **旧数据升级（v3）**：旧闸门缺池系归属，按上下游池反推补上（同系取该系、跨系取上游系、端池缺失留空）；
  反推不出的**无主闸**在 `/gates` 只读展示（行底色、「无主 · 只读」徽标、滑块与编辑/删除禁用）。
  旧走水计划缺目标池时按唯一开放下游反推，反推不出留空，补排目标池后才能放行。
