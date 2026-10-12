'use strict';



const assert = require('node:assert/strict');

const fs = require('node:fs');

const path = require('node:path');

const vm = require('node:vm');



const root = path.resolve(__dirname, '..');



function load(relative, context, transform = source => source) {

    const source = transform(fs.readFileSync(path.join(root, relative), 'utf8'));

    vm.runInContext(source, context, { filename: relative });

}



async function testJatosAdapter() {

    const appended = [];

    const unloadWarnings = [];

    const ended = [];

    const window = {

        CLTStorageFactories: {},

        jatos: {

            onLoad(callback) { callback(); },

            addJatosIds(target) {

                return Object.assign(target, {

                    studyId: 10, componentId: 20, workerId: 30,

                    studyResultId: 40, componentResultId: 50

                });

            },

            appendResultData(value) { appended.push(value); return Promise.resolve(); },

            showBeforeUnloadWarning(value) { unloadWarnings.push(value); },

            endStudyWithoutRedirect(successful, message) {

                ended.push({ successful, message });

                return Promise.resolve();

            }

        }

    };

    const context = vm.createContext({ window, console, Promise, Date, JSON, String, Boolean, Error });

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({

        experimentVersion: 'test-version', gitCommit: 'abc123'

    });

    await adapter.initialize({ participant: { subjectID: '00123', rndSeed: 123, debugMode: false } });

    const trial = {

        subjectID: '00123', block: 1, trial: 1, setSize: 4, isChange: 1,

        experimentType: 'CLT', studyDuration: 200, studyDurationActual: '216.67',

        rt: 0.5, response: 2, accuracy: 1, correctResponse: 2, rndSeed: 123

    };

    await adapter.saveTrial(trial);

    await adapter.saveCheckpoint({ block: 1, completedTrials: 50 });

    // questionnaire 透传：当前两版实验都已不再收集实验后问卷（2026-10-10 去问卷），
    // 这里刻意传一次，锁死通用存储层对 legacy payload 字段的透传能力（供后续实验复用）。
    await adapter.saveFinalResult({ trials: [trial], questionnaire: { tired: 2, attention: 4 }, probePlanViolations: 0 });

    await adapter.finishExperiment({ successful: true, message: 'CLT mouse completed' });

    const records = appended.map(line => {

        assert.ok(line.endsWith('\n'));

        return JSON.parse(line);

    });

    assert.deepEqual(records.map(record => record.record_type), ['session_start', 'trial', 'checkpoint', 'final', 'csv_upload_attempt', 'csv_upload_status']);

    for (const [key, value] of Object.entries(trial)) {

        assert.deepEqual(records[1][key], value, `JATOS trial field changed: ${key}`);

    }

    assert.equal(records[1].participant_id, '00123');

    assert.equal(records[1].experiment_version, 'test-version');

    assert.deepEqual(records[3].questionnaire, { tired: 2, attention: 4 });

    assert.deepEqual(unloadWarnings, [true, false]);

    assert.deepEqual(ended, [{ successful: true, message: 'CLT mouse completed' }]);

}



async function testSupabaseAdapter() {

    const inserts = [];

    const client = {

        from(table) {

            assert.equal(table, 'vwm_data');

            return { async insert(rows) { inserts.push(rows); return { error: null }; } };

        }

    };

    const window = {

        CLTStorageFactories: {},

        supabase: { createClient() { return client; } }

    };

    const context = vm.createContext({ window, console, Promise, Error });

    load('supabase-storage.js', context, source => source

        .replace('YOUR_SUPABASE_URL_HERE', 'https://example.supabase.co')

        .replace('YOUR_SUPABASE_PUBLISHABLE_KEY_HERE', 'test-publishable-key'));

    const adapter = window.CLTStorageFactories.supabase();

    await adapter.initialize();

    const rows = [{
        subjectID: '0001', block: 1, trial: 1, setSize: 3,
        studyDuration: 50, studyDurationActual: '66.67'
    }];

    await adapter.saveTrial(rows[0]);

    await adapter.saveCheckpoint({ block: 1 });

    await adapter.saveFinalResult({ trials: rows });

    assert.deepEqual(inserts, [rows]);

}



async function testUnconfiguredSupabasePreservesLocalOnlyMode() {

    const window = { CLTStorageFactories: {} };

    const context = vm.createContext({ window, console, Promise, Error });

    load('supabase-storage.js', context);

    const adapter = window.CLTStorageFactories.supabase();

    await adapter.initialize();

    const result = await adapter.saveFinalResult({ trials: [{ subjectID: '0' }] });

    assert.match(result.message, /未配置服务器上传/);

}





async function testJatosCsvUpload() {

    const appended = [];

    const uploadedFiles = [];

    const window = {

        CLTStorageFactories: {},

        jatos: {

            onLoad(callback) { callback(); },

            addJatosIds(target) {

                return Object.assign(target, {

                    studyId: 28539, componentId: 48905, workerId: 1202069,

                    studyResultId: 1248754, componentResultId: 1736418,

                    studyCode: 'ROzRWapgAbE', studyTitle: 'CDT Full-Probe',

                    batchId: 32325, batchTitle: 'Default',

                    componentPos: 1, componentTitle: 'CDT Full-Probe Experiment',

                    groupResultId: null, groupMemberId: null

                });

            },

            appendResultData(value) { appended.push(value); return Promise.resolve(); },

            uploadResultFile(blob, filename) {

                uploadedFiles.push({ blob, filename });

                return Promise.resolve();

            },

            showBeforeUnloadWarning() {},

            endStudyWithoutRedirect() { return Promise.resolve(); }

        }

    };

    const context = vm.createContext({ window, console, Promise, Date, JSON, String, Boolean, Error, Set, Array, Object });

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({

        experimentVersion: 'test-version', gitCommit: 'abc123'

    });

    await adapter.initialize({ participant: { subjectID: '0199997000', rndSeed: 999, debugMode: true } });

    

    // Trial 1 (accuracy = 1)

    const t1 = {

        subjectID: '0199997000', block: 1, trial: 1, setSize: 6, isChange: 0,

        experimentType: 'demo', rt: 0.34, response: 0, correctResponse: 0, accuracy: 1,

        itemLocs: [[414, 527], [173, 557]], itemColors: [6, 3], extraPropT1: 'special1'

    };

    // Trial 2 (accuracy = 0, with extra dynamic field)

    const t2 = {

        subjectID: '0199997000', block: 1, trial: 2, setSize: 6, isChange: 1,

        experimentType: 'demo', rt: 0.15, response: 0, correctResponse: 1, accuracy: 0,

        itemLocs: [[425, 506], [171, 561]], itemColors: [8, 1], extraPropT2: 'special2'

    };



    await adapter.saveTrial(t1);

    await adapter.saveTrial(t2);

    await adapter.saveFinalResult({

        trials: [t1, t2],

        // questionnaire 字段已删除（2026-10-10 与 exp1_fcdt 同步去问卷）：
        // CLT 不再收集实验后量表，saveFinalResult 的 payload 中不再传 questionnaire。

        probePlanViolations: 0,

        lowAccuracyFlag: false

    });



    assert.equal(uploadedFiles.length, 1, 'uploadResultFile should be called once');

    const { blob, filename } = uploadedFiles[0];

    assert.equal(filename, 'participant_0199997000_1248754.csv');

    

    const csvText = typeof blob === 'string' ? blob : blob.toString();

    assert.ok(csvText.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');

    

    const lines = csvText.replace(/^\uFEFF/, '').trim().split('\r\n');

    assert.equal(lines.length, 3, 'CSV must have 1 header line and 2 data lines for 2 trials');

    

    const headers = lines[0].split(',');

    assert.ok(headers.includes('participant_id'));

    assert.ok(headers.includes('subjectID'));

    assert.ok(headers.includes('session_identifier'));

    assert.ok(headers.includes('studyId'));

    assert.ok(headers.includes('workerId'));

    assert.ok(headers.includes('extraPropT1'), 'Must include union of keys from t1');

    assert.ok(headers.includes('extraPropT2'), 'Must include union of keys from t2');

    // 问卷字段已删除（2026-10-10）：CSV 不再包含 tired / attention 列
    assert.ok(!headers.includes('tired'), 'CSV must NOT include post-task questionnaire field tired');
    assert.ok(!headers.includes('attention'), 'CSV must NOT include post-task questionnaire field attention');

    assert.ok(headers.includes('probe_plan_violations'), 'Must include session summary probe_plan_violations');

    assert.ok(headers.includes('low_accuracy_flag'), 'Must include session summary low_accuracy_flag');



    // Check data row values

    // 问卷字段已删除：不再检查 tired=3 / attention=5



    // Test error resilience when uploadResultFile rejects

    window.jatos.uploadResultFile = () => Promise.reject(new Error('Network drop'));

    // Should not throw and finish gracefully

    await adapter.saveFinalResult({ trials: [t1, t2] });

    await adapter.finishExperiment({ successful: true });

}



// --- 断点续做：Batch Session 进度的读写（2026-10-10）---
// 为什么必须用 Batch Session：Result Data 只能追加、浏览器端读不回来，
// 所以它只能当审计留痕；Batch Session 是 JATOS 里唯一既持久又能读回的机制。
async function testJatosProgress() {

    const batchStore = {};

    let failTimes = 0;                  // 让 set 前 N 次失败，用于验证自动重试

    const window = {

        CLTStorageFactories: {},

        jatos: {

            // 真实 jatos.js 把 workerId 直接挂在 jatos 对象上（jatos.js Reference：
            // jatos.workerId）。这里的 mock 必须贴齐这个结构，续做键名才取得到。
            workerId: 'w-77',

            onLoad(callback) { callback(); },

            addJatosIds(target) {

                return Object.assign(target, {

                    studyId: 10, componentId: 20, workerId: 'w-77',

                    studyResultId: 40, componentResultId: 50

                });

            },

            appendResultData() { return Promise.resolve(); },

            showBeforeUnloadWarning() {},

            endStudyWithoutRedirect() { return Promise.resolve(); },

            batchSession: {

                get(key) { return batchStore[key]; },

                set(key, value) {

                    if (failTimes > 0) {

                        failTimes--;

                        return Promise.reject(new Error('模拟网络失败'));

                    }

                    batchStore[key] = value;

                    return Promise.resolve();

                },

                // 实测契约：remove 的路径必须带前导斜杠，否则服务端拒绝
                remove(path) {
                    if (typeof path !== 'string' || path[0] !== '/') {
                        return Promise.reject(new Error('Failed to apply patch: Missing leading slash'));
                    }
                    delete batchStore[path.slice(1)];
                    return Promise.resolve('Batch session update successful');
                }

            }

        }

    };

    // setTimeout 是宿主 API，vm 新上下文里没有，必须显式传入，否则重试逻辑跑不起来

    const context = vm.createContext({

        window, console, Promise, Date, JSON, String, Boolean, Error,

        setTimeout, Object

    });

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({

        experimentVersion: 'test-version', gitCommit: 'abc123'

    });

    // 适配器是 (function (global) {...})(window)，读的是 window.crypto / window.TextEncoder；
    // vm 新上下文里没有这两个宿主 API，必须显式挂上，否则 subjectID 哈希算不出来
    window.crypto = require('node:crypto').webcrypto;

    window.TextEncoder = TextEncoder;

    await adapter.initialize({

        participant: { subjectID: '00123', rndSeed: 123, debugMode: false },

        experiment: 'demo_exp'

    });

    // 1) 初始：没有可续做的进度

    assert.equal(await adapter.loadProgress(), null);

    // 2) 保存进度：调用方只给进度字段，身份字段由存储层自己注入

    const progress = {

        completedBlocks: 3,

        resumeCount: 1,

        // 故意混入历史字段：存储层必须删掉，绝不能落进 Batch Session

        subjectTail: '345678',

        subjectId: '00123',

        updatedAt: '2026-10-10T04:00:00.000Z'

    };

    assert.equal(await adapter.saveProgress(progress), true);

    // 3) 读回来只剩进度字段：subjectHash 由存储层内部使用，不外泄给实验脚本

    const loaded = await adapter.loadProgress();

    assert.deepEqual(Object.keys(loaded).sort(), ['completedBlocks', 'resumeCount', 'updatedAt']);

    assert.equal(loaded.completedBlocks, 3);

    assert.equal(loaded.resumeCount, 1);

    // 4) 键名 = 实验名 + workerId：不同实验、不同被试互不干扰

    const expectedKey = 'demo_exp:w-77';

    assert.ok(

        Object.prototype.hasOwnProperty.call(batchStore, expectedKey),

        `Batch Session 键名应为 ${expectedKey}，实际为 ${Object.keys(batchStore).join(',')}`

    );

    // 5) 隐私红线：Batch Session 对同批次所有被试可见，
    //    只允许出现 16 位十六进制的 subjectHash，绝不能出现原始编号或其片段

    const stored = batchStore[expectedKey];

    assert.equal(stored.subjectTail, undefined, '历史字段 subjectTail 不得写入');

    assert.equal(stored.subjectId, undefined, '原始被试编号不得写入');

    assert.match(stored.subjectHash, /^[0-9a-f]{16}$/, 'subjectHash 应为 16 位十六进制');

    const serialized = JSON.stringify(batchStore);

    assert.ok(!serialized.includes('00123'), 'Batch Session 不得出现被试编号');

    assert.ok(!serialized.includes('345678'), 'Batch Session 不得出现编号片段');

    // 6) 归属校验：同一个键，换一个被试读，必须拿不到别人的进度

    const otherAdapter = window.CLTStorageFactories.jatos({

        experimentVersion: 'test-version', gitCommit: 'abc123'

    });

    await otherAdapter.initialize({ participant: { subjectID: '99999' }, experiment: 'demo_exp' });

    assert.equal(await otherAdapter.loadProgress(), null, '不同被试不得读到别人的进度');

    assert.ok(await adapter.loadProgress() !== null, '同一被试仍能读到自己的进度');

    // 7) 写入失败自动重试（JATOS 作者建议：失败要重试，且重试前重新取最新数据）

    failTimes = 1;

    assert.equal(await adapter.saveProgress({ completedBlocks: 4 }), true,

        'set 失败后应重试直到成功');

    assert.equal((await adapter.loadProgress()).completedBlocks, 4);

    // 8) 清除进度（实验正常结束后调用，避免下次被误判为"上次没做完"）

    assert.equal(await adapter.clearProgress(), true);

    assert.equal(await adapter.loadProgress(), null);

}

// --- 非安全上下文（拿不到 crypto.subtle）时 fail closed：
//     宁可这一次不续做，也不能把可能属于别人的进度交出去 ---
async function testProgressFailsClosedWithoutCrypto() {

    const batchStore = {};

    const window = {

        CLTStorageFactories: {},

        jatos: {

            workerId: 'w-31',

            onLoad(callback) { callback(); },

            addJatosIds(t) { return Object.assign(t, { workerId: 'w-31', studyResultId: 9 }); },

            appendResultData() { return Promise.resolve(); },

            showBeforeUnloadWarning() {},

            endStudyWithoutRedirect() { return Promise.resolve(); },

            batchSession: {

                get(key) { return batchStore[key]; },

                set(key, value) { batchStore[key] = value; return Promise.resolve(); },

                // 实测契约：remove 的路径必须带前导斜杠，否则服务端拒绝
                remove(path) {
                    if (typeof path !== 'string' || path[0] !== '/') {
                        return Promise.reject(new Error('Failed to apply patch: Missing leading slash'));
                    }
                    delete batchStore[path.slice(1)];
                    return Promise.resolve('Batch session update successful');
                }

            }

        }

        // 故意不提供 crypto / TextEncoder —— 等价于在非安全上下文里打开页面

    };

    const context = vm.createContext({

        window, console, Promise, Date, JSON, String, Boolean, Error,

        setTimeout, Object

    });

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({ experimentVersion: 'x', gitCommit: 'y' });

    await adapter.initialize({ participant: { subjectID: '00123' }, experiment: 'demo_exp' });

    // 写入仍然成功（进度是保险机制，存不进去/存进去都不该打断实验）
    assert.equal(await adapter.saveProgress({ completedBlocks: 2 }), true);

    assert.equal(batchStore['demo_exp:w-31'].subjectHash, null, '无 crypto 时应写入 null 而不是原始编号');

    // 但读回时必须拒绝：无法确认归属
    assert.equal(await adapter.loadProgress(), null, '无法计算哈希时不得返回进度');

}

// --- 没有 Batch Session 时应优雅降级：续做只是保险，不能拖垮实验本身 ---
async function testProgressGracefulDegradation() {

    const window = {

        CLTStorageFactories: {},

        jatos: {

            // 有 workerId（真实 jatos 会挂上），但没有 batchSession —— 用于验证优雅降级
            workerId: 'w-1',

            onLoad(callback) { callback(); },

            addJatosIds(t) { return Object.assign(t, { workerId: 'w-1', studyResultId: 2 }); },

            appendResultData() { return Promise.resolve(); },

            showBeforeUnloadWarning() {},

            endStudyWithoutRedirect() { return Promise.resolve() }

            // 故意不提供 batchSession

        }

    };

    const context = vm.createContext({

        window, console, Promise, Date, JSON, String, Boolean, Error,

        setTimeout, Object

    });

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({ experimentVersion: 'x', gitCommit: 'y' });

    await adapter.initialize({ participant: { subjectID: '00123' }, experiment: 'demo_exp' });

    assert.equal(await adapter.loadProgress(), null, '无 Batch Session 时应返回 null');

    assert.equal(await adapter.saveProgress({ completedBlocks: 1 }), false,

        '无 Batch Session 时保存应返回 false 而不是抛错');

    assert.equal(await adapter.clearProgress(), false);

}

// --- 真实 JATOS 3.11.1 的 Batch Session 契约（实测得到，桩必须照抄，
//     否则这类缺陷在本地测试里永远看不见）：
//       1) remove 的路径必须以 '/' 开头，否则服务端回
//          "Failed to apply patch: Missing leading slash" —— 删除静默失败；
//       2) 同一时刻只接受一个 patch，并发提交会报
//          "Can send only one batch session patch at a time"；
//       3) 批次为空时 get() 会抛异常，而不是返回 undefined。
async function testBatchSessionRealApiContract() {

    const store = {};

    let patchInFlight = 0;

    let concurrencyViolations = 0;

    let removeWithoutSlashRejections = 0;

    const window = {

        CLTStorageFactories: {},

        jatos: {

            workerId: 'w-real',

            onLoad(callback) { callback(); },

            addJatosIds(t) { return Object.assign(t, { workerId: 'w-real', studyResultId: 7 }); },

            appendResultData() { return Promise.resolve(); },

            showBeforeUnloadWarning() {},

            endStudyWithoutRedirect() { return Promise.resolve(); },

            batchSession: {

                get(key) {

                    // 实测：批次为空时 get 抛异常

                    if (Object.keys(store).length === 0) throw new Error('Batch session is empty');

                    return store[key];

                },

                set(key, value) {

                    if (patchInFlight > 0) { concurrencyViolations++; return Promise.reject(new Error('Can send only one batch session patch at a time.')); }

                    patchInFlight++;

                    return new Promise(resolve => setTimeout(() => {

                        store[key] = value;

                        patchInFlight--;

                        resolve('Batch session update successful');

                    }, 5));

                },

                remove(path) {

                    if (typeof path !== 'string' || path[0] !== '/') {

                        removeWithoutSlashRejections++;

                        return Promise.reject(new Error('Failed to apply patch: Missing leading slash'));

                    }

                    if (patchInFlight > 0) { concurrencyViolations++; return Promise.reject(new Error('Can send only one batch session patch at a time.')); }

                    patchInFlight++;

                    return new Promise(resolve => setTimeout(() => {

                        delete store[path.slice(1)];

                        patchInFlight--;

                        resolve('Batch session update successful');

                    }, 5));

                }

            }

        }

    };

    const context = vm.createContext({

        window, console, Promise, Date, JSON, String, Boolean, Error,

        setTimeout, Object

    });

    window.crypto = require('node:crypto').webcrypto;

    window.TextEncoder = TextEncoder;

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({ experimentVersion: 'x', gitCommit: 'y' });

    await adapter.initialize({ participant: { subjectID: '00123' }, experiment: 'demo_exp' });

    // 3) 空批次：get 抛异常也不能泄漏出来，必须当作"没有进度"

    assert.equal(await adapter.loadProgress(), null, '批次为空（get 抛异常）时必须返回 null');

    // 1) 写入后能读回

    assert.equal(await adapter.saveProgress({ completedBlocks: 5 }), true);

    assert.equal((await adapter.loadProgress()).completedBlocks, 5);

    // 并发写入必须被串行化（否则真实服务端会拒绝其中一个 patch）。
    // 超时兜底：适配器一旦死锁（例如重试逻辑再次入队、等自己），
    // 必须让测试失败，而不是让整个测试挂住。
    await Promise.race([
        Promise.all([adapter.saveProgress({ completedBlocks: 6 }), adapter.saveProgress({ completedBlocks: 7 })]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('并发 patch 超时：适配器可能死锁')), 5000))
    ]);

    assert.equal(concurrencyViolations, 0, '并发 patch 必须由适配器串行化');

    assert.equal(removeWithoutSlashRejections, 0, 'remove 必须带前导斜杠');

    // 2) 清除必须真的从服务端删掉（这是本测试的核心回归点）

    assert.equal(await adapter.clearProgress(), true, 'clearProgress 必须返回 true');

    assert.deepEqual(Object.keys(store), [], 'clearProgress 之后服务端不得再留有进度键');

    assert.equal(await adapter.loadProgress(), null, '清除后不得再读到进度');

}

// --- 进度键名必须带实验名：调用方漏传 experiment 时宁可关闭续做，
//     也不能让不同实验共用同一个 Batch Session 键（否则进度互相覆盖） ---
async function testProgressRequiresExperimentName() {

    const batchStore = {};

    const window = {

        CLTStorageFactories: {},

        jatos: {

            workerId: 'w-9',

            onLoad(callback) { callback(); },

            addJatosIds(t) { return Object.assign(t, { workerId: 'w-9', studyResultId: 5 }); },

            appendResultData() { return Promise.resolve(); },

            showBeforeUnloadWarning() {},

            endStudyWithoutRedirect() { return Promise.resolve(); },

            batchSession: {

                get(key) { return batchStore[key]; },

                set(key, value) { batchStore[key] = value; return Promise.resolve(); },

                // 实测契约：remove 的路径必须带前导斜杠，否则服务端拒绝
                remove(path) {
                    if (typeof path !== 'string' || path[0] !== '/') {
                        return Promise.reject(new Error('Failed to apply patch: Missing leading slash'));
                    }
                    delete batchStore[path.slice(1)];
                    return Promise.resolve('Batch session update successful');
                }

            }

        }

    };

    const context = vm.createContext({

        window, console, Promise, Date, JSON, String, Boolean, Error,

        setTimeout, Object

    });

    load('jatos-storage.js', context);

    const adapter = window.CLTStorageFactories.jatos({ experimentVersion: 'x', gitCommit: 'y' });

    // 故意漏传 experiment —— 这是"两个实验共用 exp:<workerId> 键"的复现条件
    await adapter.initialize({ participant: { subjectID: '00123' } });

    assert.equal(await adapter.loadProgress(), null, '缺 experiment 时不应读到任何进度');

    assert.equal(await adapter.saveProgress({ completedBlocks: 1 }), false,

        '缺 experiment 时不应写入任何进度');

    assert.deepEqual(Object.keys(batchStore), [],

        '缺 experiment 时不得写出任何 Batch Session 键（否则会覆盖别的实验）');

}

async function main() {

    await testJatosCsvUpload();

    await testJatosAdapter();

    await testSupabaseAdapter();

    await testUnconfiguredSupabasePreservesLocalOnlyMode();

    await testJatosProgress();

    await testProgressGracefulDegradation();

    await testProgressRequiresExperimentName();

    await testProgressFailsClosedWithoutCrypto();

    await testBatchSessionRealApiContract();

    console.log('storage-adapters.test.js: PASS');

}



// 死锁兜底：Promise 队列一旦自等（例如重试逻辑再次入队），node 会因为事件循环
// 变空而"安静地"以 0 退出、既不报错也不打印 PASS。这里把"没跑完就退出"变成失败。
let completed = false;

process.on('exit', code => {
    if (!completed && code === 0) {
        console.error('storage-adapters.test.js: main() did not complete (deadlock?)');
        process.exitCode = 1;
    }
});

main().then(() => { completed = true; }, error => { console.error(error); process.exitCode = 1; });

