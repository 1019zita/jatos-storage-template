# jatos-storage-template

JATOS / Supabase 存储层的**唯一权威实现**。所有网页实验（CLT、Full-Probe、Single-Probe 等）共用这一份代码，
不再各自复制 `src/storage/`。

## 为什么存在

同一套存储层此前被复制到 5 个仓库，各自缓慢分叉；续做功能（Batch Session）出现过的
「进度键名退化成 `exp:<workerId>`」「`resumeCount` 永不递增」两个缺陷，都是复制之后只改了一处造成的。
现在只有一份实现，改一次即全部生效。

## 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 门面 | `index.js` | 后端选择（`CLT_STORAGE_BACKEND`）、适配器生命周期、**唯一**的缺方法兜底 |
| 适配器 | `jatos-storage.js` | JATOS：Result Data 追加、CSV result file、Batch Session 进度 |
| 适配器 | `supabase-storage.js` | legacy Supabase（占位配置，默认本地模式） |
| 测试 | `tests/storage-adapters.test.js` | 上述三层的行为契约 |

加载顺序（入口 HTML 里按此顺序写 `<script>`）：后端适配器 → `index.js` → 实验脚本。
`index.js` 在加载时读取 `window.CLTStorageFactories`，因此适配器必须先加载。

## 对外契约（`window.CLTStorage`）

| 方法 | 说明 |
|---|---|
| `initializeStorage({ participant, experiment, build? })` | `experiment` **必填**：决定 Batch Session 进度键名 |
| `saveTrial(row)` | 追加一条 `trial` 记录 |
| `saveCheckpoint(cp)` | 追加一条 `checkpoint` 记录（审计用，不可读回） |
| `saveFinalResult(payload)` | 追加 `final` 记录，并上传 participant CSV result file |
| `finishExperiment(status)` | flush 队列并结束 Study |
| `loadProgress()` | 读回进度；**归属由键名保证**（键名含被试哈希），读不到别人的进度 |
| `saveProgress(progress)` | 写进度；记录里只放进度字段，调用方传入的任何身份字段一律删除 |
| `clearProgress()` | 清除进度（实验正常结束 / 被试选择重新开始时调用） |
| `getMetadata()` / `backendName` | 当前后端与构建元数据 |

实验脚本**不需要**（也不应该）自己计算身份哈希或判断归属。

## 隐私红线（Batch Session 对同批次所有被试可见）

- 记录里只允许出现进度字段：`completedBlocks` / `resumeCount` / `updatedAt`。
- 唯一与身份有关的东西是 `subjectHash` = `SHA-256(subjectID)` 前 16 位十六进制，
  它只出现在**键名**里，由本层自己算、自己用。原始编号及其片段（历史字段 `subjectTail`）一律不写入。
- **强度边界**：`subjectID` 只有 10 位数字（身份证后 6 位 + 手机后 4 位），空间仅 10^10，
  拿到哈希的人仍可离线穷举。它挡的是「同批次被试随手看到别人的身份证 / 手机号片段」，
  不是密码学意义上的匿名化。要更强就得放弃"同一个人可续做"这个能力（那需要与人员无关的键）。
- 拿不到 `crypto.subtle`（非 HTTPS / 非 localhost）时算不出哈希 → 关闭续做能力（不写不读不落键），
  而不是退回某个弱标识。

## 进度键名

`<experiment>:<subjectHash>`，例如 `exp1_clt:75eb1f04e696914b`。

- `experiment` 由实验脚本传入，保证同一 Study 下不同实验的进度互不覆盖。
- `subjectHash` 与被试绑定，**不依赖链接类型**：同一个人换标签页、关窗重进、换设备都落到同一个键；
  不同的人天然落到不同键。缺任意一个即关闭续做能力并 `console.warn`，不会退回某个共用键。

早期版本用的是 `jatos.workerId` 作后缀，2026-10-12 在 MindProbe 实测后被替换：

| 实测 | 结果 |
|---|---|
| 同一条 General Multiple 链接连续运行三次 | workerId = **1221113 / 1221129 / 1221133**（每次都是新的） |
| cookie 证据 | 只有 `JATOS_ID_<studyResultId>`（每个 study result 一个），没有 worker 级 cookie；`workerType=GeneralMultiple` |
| 后果 | 键名每次都不同 → `loadProgress()` 永远读到空 → **续做永不触发**，还在 Batch Session 里留下垃圾键 |
| 症状 | 非 debug 跑到 block 1 结束（进度写在 `exp1_clt:1221129`），用**同一身份证/手机号**重开链接 → 新 workerId → `resumeStartBlock=1`，没有续做 |

Personal Single / Multiple 链接下 workerId 是稳定的（JATOS 把 worker 绑在链接上），
所以旧写法只在 Personal 链接上碰巧可用——依赖链接类型是隐患，现已改为与被试绑定。

## Batch Session 实测契约（JATOS 3.11.1，2026-10-12 在真实实例上量得）

这几点用桩测不出来，必须照抄，否则续做会**静默**失效：

| 行为 | 实测结果 | 本层的处理 |
|---|---|---|
| `batchSession.remove(path)` | 路径不带前导 `/` 时服务端回 `Failed to apply patch: Missing leading slash`，删除**不生效**（进度会永久留在服务端，同一位被试下次进来被误判为"上次没做完"） | 统一用 `remove('/' + key)`；失败重试一次；真失败时 `console.warn` 并返回 `false`（不再静默吞掉） |
| 并发 patch | 同一时刻只接受一个，第二个回 `Can send only one batch session patch at a time` | 所有写/删经 `enqueueBatchPatch` 串行化 |
| `batchSession.get(key)` | 批次为空时**抛异常**（不是返回 `undefined`） | 包在 `try/catch` 里，失败一律当"没有进度" |
| `add` / `set(key, null)` 作为删除兜底 | 不可用：`add` 要求 key 不存在；`set(key, null)` 只是把值写成 `null`，并没有删除 | 已删除这两个兜底分支 |
| `defined()` / `test()` | 与 `get()` 的本地缓存不同步（删掉之后 `defined` 可能仍为 `false`、`test` 仍为 `true`） | 一律以 `get()` 为准 |

回归测试 `testBatchSessionRealApiContract` 用照抄上述契约的桩覆盖这五点，
并对并发 patch 加了超时兜底、对"Promise 队列自等导致的静默退出"加了 `process.on('exit')` 兜底。

## 如何被实验仓库引用

作为 **git submodule** 挂在实验仓库的 `src/storage`，这样入口 HTML 里的
`src/storage/index.js` / `src/storage/jatos-storage.js` 路径不用改，构建脚本也不用改：

```bash
git submodule add https://github.com/1019zita/jatos-storage-template.git src/storage
git submodule update --init --recursive    # 克隆实验仓库之后必须执行一次
```

实验仓库的 `scripts/build_study_assets.py` 会在资产缺失时给出明确报错，提示执行上面第二条命令。

## 本地检查

```bash
node --check index.js && node --check jatos-storage.js && node --check supabase-storage.js
node --test tests/storage-adapters.test.js
```

在实验仓库里跑同一套测试（submodule 内路径自洽）：

```bash
node --test src/storage/tests/storage-adapters.test.js
```

## 版本

`VERSION` 只记录存储层自身的接口版本；实验版本由各实验仓库的 `VERSION` 与 `build-info.json` 记录。
