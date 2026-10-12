(function (global) {
    'use strict';

    global.CLTStorageFactories = global.CLTStorageFactories || {};
    global.CLTStorageFactories.jatos = function createJatosStorage(deploymentMetadata) {
        let context = null;
        let queue = Promise.resolve();
        let firstWriteError = null;
        let readyPromise = null;
        const recordedTrials = [];
        // 断点续做用的 Batch Session 键名，形如 "exp1_fcdt:<workerId>"
        // 之所以按 workerId 分键：Batch Session 对同批次所有被试可见，
        // 分键可把每个人的进度隔离在自己的键下，也避免多人并发写同一对象导致冲突。
        let progressKeyName = null;

        function getReadyPromise() {
            if (readyPromise) return readyPromise;
            readyPromise = new Promise((resolve, reject) => {
                if (!global.jatos || typeof global.jatos.onLoad !== 'function') {
                    reject(new Error('jatos.js is unavailable'));
                    return;
                }
                global.jatos.onLoad(resolve);
            });
            return readyPromise;
        }

        function jatosIds() {
            if (typeof global.jatos.addJatosIds === 'function') return global.jatos.addJatosIds({});
            return {
                studyId: global.jatos.studyId,
                componentId: global.jatos.componentId,
                workerId: global.jatos.workerId,
                studyResultId: global.jatos.studyResultId,
                componentResultId: global.jatos.componentResultId
            };
        }

        // ---------- Batch Session：断点续做专用 ----------
        // 为什么用 Batch Session 而不是 Result Data：
        //   Result Data 只能追加（appendResultData），浏览器端没有任何读取接口，
        //   所以它只能当审计留痕，撑不起"续做"。Batch Session 是 JATOS 里唯一
        //   既持久（跨浏览器关闭仍在）、又能被组件读回的机制。
        //
        // 官方安全警告（务必遵守）：Batch Session 的数据对客户端可见，
        // 同批次被试都能读到。因此这里**只存进度**，绝不写入
        // 姓名 / 身份证 / 手机号 / 性别 / 年龄等任何个人信息。
        //
        // 唯一与身份有关的字段是 subjectHash（subjectID 的 SHA-256 前 16 位十六进制）。
        // 它只用于回答"这条进度是不是同一个人留下的"，由本层自己算、自己比：
        // 实验脚本既不传也不读，原始编号不会散落到第二个地方。
        // 强度边界要说清楚：subjectID 只有 10 位数字（身份证后6位 + 手机后4位），
        // 空间仅 10^10，拿到哈希的人仍可离线穷举；它挡的是"同批次被试随手看到
        // 别人的身份证 / 手机号片段"，不是密码学意义上的匿名化。
        // ---------- 进度归属：subjectID 的单向哈希 ----------
        // 只在安全上下文（HTTPS / localhost）可用；拿不到 crypto.subtle 时返回 null，
        // 调用方据此 fail closed（宁可不续做，也不能把别人的进度交出去）。
        const SUBJECT_HASH_HEX_CHARS = 16;

        async function hashSubjectId(value) {
            const raw = (value === undefined || value === null) ? '' : String(value).trim();
            if (!raw) return null;
            const subtle = global.crypto && global.crypto.subtle;
            if (!subtle || typeof subtle.digest !== 'function') return null;
            try {
                const bytes = new global.TextEncoder().encode(raw);
                const digest = await subtle.digest('SHA-256', bytes);
                return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0'))
                    .join('')
                    .slice(0, SUBJECT_HASH_HEX_CHARS);
            } catch (error) {
                console.warn('[CLT storage] subjectID 哈希失败：', error);
                return null;
            }
        }

        function subjectIdFromContext() {
            return (context && context.participant) ? context.participant.subjectID : '';
        }

        function batchSessionAvailable() {
            return Boolean(global.jatos && global.jatos.batchSession);
        }

        // 读：jatos.batchSession.get / find 是同步的（读的是本地副本，不发请求）。
        // key 不存在时返回 undefined。
        function batchGet(key) {
            if (!batchSessionAvailable()) return undefined;
            const bs = global.jatos.batchSession;
            try {
                if (typeof bs.get === 'function') return bs.get(key);
                if (typeof bs.find === 'function') return bs.find('/' + key);
            } catch (error) {
                console.warn('[CLT storage] 读取 Batch Session 失败：', error);
            }
            return undefined;
        }

        // 写：jatos.batchSession.set 返回 Promise，可能因网络/服务端或数据冲突失败。
        // 按 JATOS 作者建议：失败要重试，且重试前重新取最新数据。
        // 由于每个被试只写自己的 key（workerId 隔离），冲突概率极低。
        function batchSet(key, value, attempt) {
            const tries = attempt || 0;
            if (!batchSessionAvailable() || typeof global.jatos.batchSession.set !== 'function') {
                return Promise.reject(new Error('jatos.batchSession.set is unavailable'));
            }
            return global.jatos.batchSession.set(key, value).catch(error => {
                if (tries >= 2) throw error;
                const delay = 500 * (tries + 1);
                console.warn(`[CLT storage] Batch Session 写入失败，${delay}ms 后重试（第 ${tries + 1} 次）：`, error);
                return new Promise(resolve => setTimeout(resolve, delay))
                    .then(() => batchSet(key, value, tries + 1));
            });
        }

        // 删：实验正常结束后清掉进度，避免下次误续。
        // remove 不可用时退化为写入 null（再读回来是 null，等价于"没有进度"）。
        function batchRemove(key) {
            if (!batchSessionAvailable()) return Promise.resolve(false);
            const bs = global.jatos.batchSession;
            try {
                if (typeof bs.remove === 'function') {
                    return bs.remove(key).then(() => true).catch(() => false);
                }
                if (typeof bs.add === 'function') {
                    return bs.add('/' + key, null).then(() => true).catch(() => false);
                }
                if (typeof bs.set === 'function') {
                    return bs.set(key, null).then(() => true).catch(() => false);
                }
            } catch (error) {
                console.warn('[CLT storage] 清除 Batch Session 进度失败：', error);
            }
            return Promise.resolve(false);
        }

        function envelope(recordType, data) {
            const ids = jatosIds();
            return {
                record_type: recordType,
                participant_id: String(context ? context.participant.subjectID : ''),
                session_identifier: String(ids.studyResultId || global.jatos.studyResultId || ''),
                experiment_version: deploymentMetadata.experimentVersion,
                git_commit: deploymentMetadata.gitCommit,
                timestamp: new Date().toISOString(),
                ...ids,
                ...data
            };
        }

        function formatCsvCell(val) {
            if (val === undefined || val === null) return '';
            let str = (typeof val === 'object') ? JSON.stringify(val) : String(val);
            if (str.indexOf('"') !== -1 || str.indexOf(',') !== -1 || str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        }

        function buildTrialsCSV(trials, sessionSummary) {
            if (!trials || trials.length === 0) return '';
            const priorityColumns = [
                'participant_id', 'subjectID', 'session_identifier',
                'experiment_version', 'git_commit', 'timestamp', 'debug_mode', 'rndSeed',
                'studyCode', 'studyId', 'studyTitle', 'batchId', 'batchTitle',
                'componentId', 'componentPos', 'componentTitle',
                'workerId', 'studyResultId', 'componentResultId',
                'groupResultId', 'groupMemberId',
                'block', 'trial', 'setSize', 'isChange', 'experimentType',
                'rt', 'response', 'correctResponse', 'accuracy'
            ];

            const allKeysSet = new Set();
            const summaryObj = (sessionSummary && typeof sessionSummary === 'object') ? sessionSummary : {};
            const summaryKeys = Object.keys(summaryObj);
            for (const t of trials) {
                for (const k of Object.keys(t)) {
                    if (k !== 'record_type') allKeysSet.add(k);
                }
            }
            for (const sk of summaryKeys) {
                allKeysSet.add(sk);
            }
            const remainingKeys = Array.from(allKeysSet).filter(k => !priorityColumns.includes(k));
            const columns = priorityColumns.concat(remainingKeys);

            const lines = [columns.join(',')];
            for (const t of trials) {
                const mergedTrial = Object.assign({}, t, summaryObj);
                lines.push(columns.map(col => formatCsvCell(mergedTrial[col])).join(','));
            }
            return '\uFEFF' + lines.join('\r\n') + '\r\n';
        }

        function append(record) {
            const line = JSON.stringify(record) + '\n';
            queue = queue.then(() => global.jatos.appendResultData(line)).catch(error => {
                if (!firstWriteError) firstWriteError = error;
            });
            return queue;
        }

        async function flush() {
            await queue;
            if (firstWriteError) throw firstWriteError;
        }

        return {
            async initialize(initialContext) {
                await getReadyPromise();
                context = initialContext;

                // 进度键名 = experiment + ':' + workerId，两者都必须由调用方给出：
                //   experiment：实验脚本传入（exp1_clt / exp1_fcdt），保证同一 Study 下
                //     不同实验的进度互不覆盖；
                //   workerId：JATOS 分配并存在浏览器 cookie 里——同一浏览器重开同一条
                //     被试链接时会拿到同一个 workerId，续做正是依赖这一点。
                // 缺任意一个（本地脱离 JATOS 直接打开，或调用方漏传 experiment）就关闭
                // 续做能力：宁可没有进度，也不能让两个实验落到同一个键上。
                const expName = (context && context.experiment) ? String(context.experiment).trim() : '';
                const workerId = (global.jatos && global.jatos.workerId) ? String(global.jatos.workerId) : '';
                progressKeyName = (expName && workerId) ? (expName + ':' + workerId) : null;
                if (!progressKeyName) {
                    console.warn('[CLT storage] 缺少 experiment 名称或 workerId，断点续做已关闭（其余功能不受影响）');
                }

                if (typeof global.jatos.showBeforeUnloadWarning === 'function') global.jatos.showBeforeUnloadWarning(true);
                await append(envelope('session_start', {
                    debug_mode: Boolean(context.participant.debugMode),
                    rndSeed: context.participant.rndSeed
                }));
                await flush();
            },
            saveTrial(row) {
                const env = envelope('trial', row);
                recordedTrials.push(env);
                return append(env);
            },
            // 审计留痕：每个 block 结束时仍往 Result Data 写一条 checkpoint。
            // 注意它只能写不能读，所以**不能**用来续做，只用于事后核对。
            saveCheckpoint(checkpoint) { return append(envelope('checkpoint', checkpoint)); },

            // 读取上次未完成的进度。返回 null = "没有可续做的进度"。
            // 归属校验在本层完成：只有 subjectHash 与当前被试一致时才返回；
            // 缺哈希（非安全上下文）或哈希不一致一律返回 null（fail closed）。
            // 返回的对象已去掉 subjectHash —— 实验脚本不需要、也不应该依赖它。
            loadProgress() {
                if (!progressKeyName) return Promise.resolve(null);
                const raw = batchGet(progressKeyName);
                if (!raw || typeof raw !== 'object') return Promise.resolve(null);
                return hashSubjectId(subjectIdFromContext()).then(ownHash => {
                    if (!ownHash) {
                        console.warn('[CLT storage] 无法计算 subjectID 哈希（非安全上下文），本次不续做。');
                        return null;
                    }
                    if (raw.subjectHash !== ownHash) {
                        console.warn('[CLT storage] 该进度属于其他被试，本次不续做。');
                        return null;
                    }
                    const progress = Object.assign({}, raw);
                    delete progress.subjectHash;
                    return progress;
                });
            },

            // 保存进度。progress 只放进度信息；身份字段由本层自己注入，
            // 调用方误传的 subjectTail / subjectId 一律删除（原始编号禁止进 Batch Session）。
            saveProgress(progress) {
                if (!progressKeyName) return Promise.resolve(false);
                return hashSubjectId(subjectIdFromContext()).then(subjectHash => {
                    const record = Object.assign({}, progress, { subjectHash: subjectHash });
                    delete record.subjectTail;
                    delete record.subjectId;
                    return batchSet(progressKeyName, record)
                        .then(() => true)
                        .catch(error => {
                            // 续做只是保险机制，存不进去不能影响实验本身继续跑
                            console.warn('[CLT storage] 进度保存失败（不影响实验进行）：', error);
                            return false;
                        });
                });
            },

            // 实验正常结束后清除进度，避免同一个被试下次进来被误判为"上次没做完"。
            clearProgress() {
                if (!progressKeyName) return Promise.resolve(false);
                return batchRemove(progressKeyName);
            },
            saveFinalResult(payload) {
                const trials = payload && Array.isArray(payload.trials) ? payload.trials : [];
                return append(envelope('final', {
                    trial_count: trials.length,
                    questionnaire: payload ? payload.questionnaire : undefined,
                    probe_plan_violations: payload ? payload.probePlanViolations : undefined,
                    low_accuracy_flag: payload ? Boolean(payload.lowAccuracyFlag) : undefined,
                    low_accuracy_block_count: payload ? payload.lowAccuracyBlockCount : undefined
                })).then(async () => {
                    const partId = String((context && context.participant && context.participant.subjectID) || (recordedTrials[0] && recordedTrials[0].participant_id) || 'unknown');
                    const sessId = String((recordedTrials[0] && recordedTrials[0].session_identifier) || global.jatos.studyResultId || '0');
                    const filename = `participant_${partId}_${sessId}.csv`;

                    const hasUploadFn = typeof global.jatos.uploadResultFile === 'function';
                    await append(envelope('csv_upload_attempt', {
                        filename: filename,
                        has_upload_fn: hasUploadFn,
                        recorded_trials_count: recordedTrials.length
                    }));

                    if (hasUploadFn && recordedTrials.length > 0) {
                        try {
                            const sessionSummary = {};
                            if (payload && typeof payload === 'object') {
                                if (payload.questionnaire && typeof payload.questionnaire === 'object') {
                                    Object.assign(sessionSummary, payload.questionnaire);
                                }
                                if (payload.probePlanViolations !== undefined) sessionSummary.probe_plan_violations = payload.probePlanViolations;
                                if (payload.lowAccuracyFlag !== undefined) sessionSummary.low_accuracy_flag = Boolean(payload.lowAccuracyFlag);
                                if (payload.lowAccuracyBlockCount !== undefined) sessionSummary.low_accuracy_block_count = payload.lowAccuracyBlockCount;
                            }

                            const csvContent = buildTrialsCSV(recordedTrials, sessionSummary);
                            const blob = (typeof global.Blob === 'function')
                                ? new global.Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
                                : csvContent;
                            await global.jatos.uploadResultFile(blob, filename);
                            await append(envelope('csv_upload_status', {
                                success: true,
                                filename: filename
                            }));
                        } catch (uploadError) {
                            const errMsg = (uploadError && (uploadError.message || uploadError.toString())) || 'unknown error';
                            await append(envelope('csv_upload_status', {
                                success: false,
                                filename: filename,
                                error: errMsg
                            }));
                            if (typeof global.console !== 'undefined' && typeof global.console.warn === 'function') {
                                global.console.warn('JATOS uploadResultFile warning (non-blocking):', uploadError);
                            }
                        }
                    } else if (!hasUploadFn) {
                        await append(envelope('csv_upload_status', {
                            success: false,
                            filename: filename,
                            error: 'global.jatos.uploadResultFile is not a function'
                        }));
                    }
                    await flush();
                    return { message: '数据已保存到 JATOS。' };
                });
            },
            async finishExperiment(status) {
                await flush();
                if (typeof global.jatos.showBeforeUnloadWarning === 'function') global.jatos.showBeforeUnloadWarning(false);
                const successful = !status || status.successful !== false;
                const message = status && status.message ? String(status.message).slice(0, 255) : '';
                if (typeof global.jatos.endStudyWithoutRedirect === 'function') {
                    await global.jatos.endStudyWithoutRedirect(successful, message);
                } else if (typeof global.jatos.endStudyAjax === 'function') {
                    await global.jatos.endStudyAjax(successful, message);
                } else {
                    throw new Error('JATOS end-study function is unavailable');
                }
                return { message: '' };
            }
        };
    };
})(window);
