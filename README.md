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
| `loadProgress()` | 读回进度；**归属校验已在本层完成**，不属于当前被试时返回 `null` |
| `saveProgress(progress)` | 写进度；身份字段由本层自己注入，调用方传入的一律删除 |
| `clearProgress()` | 清除进度（实验正常结束 / 被试选择重新开始时调用） |
| `getMetadata()` / `backendName` | 当前后端与构建元数据 |

实验脚本**不需要**（也不应该）自己计算身份哈希或判断归属。

## 隐私红线（Batch Session 对同批次所有被试可见）

- 只允许写进度字段：`completedBlocks` / `resumeCount` / `updatedAt`。
- 唯一与身份有关的字段是 `subjectHash` = `SHA-256(subjectID)` 前 16 位十六进制，由本层计算与比对；
  原始编号及其片段（历史字段 `subjectTail`）一律不写入。
- **强度边界**：`subjectID` 只有 10 位数字（身份证后 6 位 + 手机后 4 位），空间仅 10^10，
  拿到哈希的人仍可离线穷举。它挡的是「同批次被试随手看到别人的身份证 / 手机号片段」，
  不是密码学意义上的匿名化。要更强就把这个字段删掉、只靠 `workerId` 隔离。
- 拿不到 `crypto.subtle`（非 HTTPS / 非 localhost）时哈希为 `null`，`loadProgress()` 一律返回 `null`
  （fail closed：宁可不续做，也不把可能属于别人的进度交出去）。

## 进度键名

`<experiment>:<workerId>`，例如 `exp1_clt:w-77`。两者缺任意一个即关闭续做能力并 `console.warn`，
不会退回某个共用键——否则同一 Study 下两个实验会互相覆盖进度。

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
