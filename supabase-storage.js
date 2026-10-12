(function (global) {
    'use strict';

    const SUPABASE_URL = 'YOUR_SUPABASE_URL_HERE';
    const SUPABASE_KEY = 'YOUR_SUPABASE_PUBLISHABLE_KEY_HERE';
    const BASE_COLUMNS = [
        'subjectID', 'subName', 'subGender', 'subAge', 'subIdCard', 'subPhone',
        'block', 'trial', 'setSize', 'isChange', 'experimentType',
        'rt', 'response', 'accuracy', 'correctResponse', 'rndSeed'
    ];

    function stripToBaseColumns(row) {
        const out = {};
        for (const key of BASE_COLUMNS) if (row[key] !== undefined) out[key] = row[key];
        return out;
    }

    global.CLTStorageFactories = global.CLTStorageFactories || {};
    global.CLTStorageFactories.supabase = function createSupabaseStorage() {
        let client = null;
        return {
            async initialize() {
                if (SUPABASE_URL === 'YOUR_SUPABASE_URL_HERE') return;
                if (!global.supabase || typeof global.supabase.createClient !== 'function') {
                    throw new Error('Supabase JavaScript client is unavailable');
                }
                client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
            },
            saveTrial() { return Promise.resolve(); },
            saveCheckpoint() { return Promise.resolve(); },
            // Supabase 后端不提供续做：若将来要支持，需额外建表存进度，
            // 并注意不要把身份证 / 手机号等个人信息写进第三方库。
            loadProgress() { return Promise.resolve(null); },
            saveProgress() { return Promise.resolve(false); },
            clearProgress() { return Promise.resolve(false); },
            async saveFinalResult(payload) {
                const rows = payload && Array.isArray(payload.trials) ? payload.trials : [];
                if (!client) return { message: '本版本未配置服务器上传，仅生成本地 Excel。' };
                if (rows.length === 0) return { message: '没有正式实验数据需要上传。' };
                const { error } = await client.from('vwm_data').insert(rows);
                if (!error) return { message: '数据上传服务器成功。' };
                console.error('[CLT storage] Supabase full-row insert failed; retrying base columns:', error);
                const { error: retryError } = await client.from('vwm_data').insert(rows.map(stripToBaseColumns));
                if (retryError) throw retryError;
                return { message: '数据上传服务器成功（按基础字段）。' };
            },
            finishExperiment() { return Promise.resolve({ message: '' }); }
        };
    };
})(window);
