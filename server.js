'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = process.env.THI_DUA_DATA_DIR
    ? path.resolve(process.env.THI_DUA_DATA_DIR)
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'BangChamDiemThiDua');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const DEFAULT_POSITIVE = [
    'Tư tưởng cán bộ, chiến sĩ ổn định',
    'Tổ chức thực hiện nhiệm vụ nghiêm túc',
    'Nội vụ vệ sinh gọn sạch, thống nhất',
    'Lễ tiết, tác phong có chuyển biến tiến bộ',
    'Tuần tra, canh gác bảo đảm an toàn',
    'Chấp hành tốt các chế độ, nền nếp',
    'Công tác huấn luyện bảo đảm yêu cầu',
    'Đoàn kết nội bộ tốt',
    'Công tác hậu cần bảo đảm',
    'Chủ động khắc phục hạn chế tuần trước',
    'Tích cực thực hiện nhiệm vụ đột xuất',
    'Duy trì tốt nền nếp chính quy'
];
const DEFAULT_NEGATIVE = [
    'Tác phong thực hiện nhiệm vụ còn chậm',
    'Trật tự nghe đọc báo, xem thời sự chưa nghiêm',
    'Nội vụ vệ sinh một số vị trí chưa đều',
    'Ý thức tự giác chưa cao ở một số thời điểm',
    'Nền nếp chính quy duy trì chưa thường xuyên',
    'Chậm khắc phục hạn chế đã chỉ ra',
    'Chất lượng thực hiện nhiệm vụ chưa đồng đều',
    'Công tác kiểm tra, đôn đốc chưa thường xuyên',
    'Phối hợp thực hiện nhiệm vụ chưa nhịp nhàng',
    'Chấp hành giờ giấc còn hạn chế',
    'Báo cáo tình hình chưa kịp thời',
    'Biện pháp khắc phục chưa cụ thể'
];

function defaultStore() {
    return {
        version: 1,
        nextUnitId: 4,
        units: [
            { id: 1, name: 'Trung đội 1' },
            { id: 2, name: 'Trung đội 2' },
            { id: 3, name: 'Đại đội bộ' }
        ],
        criteria: [1, 2, 3, 4].map(n => ({ code: `MT${n}`, label: `MT${n}`, active: true })),
        scores: [],
        remarks: {},
        settings: {
            unit_title: 'ĐẠI ĐỘI 9',
            group_title: 'TỔ THI ĐUA - KHEN THƯỞNG',
            report_title: 'TỔNG HỢP',
            campaign_title: 'Thượng úy Phan Đình Tuấn - Chính trị viên Đại đội 9',
            report_place: '',
            period_start: '',
            period_end: '',
            gemini_model: 'gemini-2.5-flash'
        }
    };
}

let store;
let volatileGeminiKey = '';
let writeQueue = Promise.resolve();

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function jsonResponse(res, status, value) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(value));
}

function validateLocalRequest(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
        throw httpError(403, 'Service chỉ chấp nhận kết nối localhost.');
    }

    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw httpError(403, 'Origin không hợp lệ.');
        }
        if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port !== String(PORT)) {
            throw httpError(403, 'Yêu cầu khác nguồn bị từ chối.');
        }
    } else if (origin === 'null') {
        throw httpError(403, 'Hãy mở ứng dụng qua địa chỉ localhost, không mở trực tiếp bằng file.');
    }
}

async function readJson(req) {
    let text = '';
    for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 1024 * 1024) {
            throw httpError(413, 'Dữ liệu gửi lên vượt quá giới hạn 1 MB.');
        }
    }
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw httpError(400, 'Nội dung JSON không hợp lệ.');
    }
}

async function persist(next) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tempFile = path.join(DATA_DIR, `data-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(tempFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tempFile, DATA_FILE);
    } catch (error) {
        await fs.rm(tempFile, { force: true }).catch(() => {});
        throw error;
    }
}

function mutate(change) {
    const operation = writeQueue.then(async () => {
        const next = structuredClone(store);
        const result = change(next);
        await persist(next);
        store = next;
        return result;
    });
    writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function dateUtc(value) {
    if (!validDate(value)) throw httpError(400, 'Ngày phải theo định dạng YYYY-MM-DD.');
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
    const date = dateUtc(value);
    date.setUTCDate(date.getUTCDate() + days);
    return isoDate(date);
}

function monday(value) {
    const date = dateUtc(value);
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    return isoDate(date);
}

function validMonth(value) {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
        throw httpError(400, 'Tháng phải theo định dạng YYYY-MM.');
    }
    return value;
}

function numberField(value, label, { min = -Infinity, max = Infinity, required = true } = {}) {
    if (value === '' || value === null || value === undefined) {
        if (!required) return null;
        throw httpError(400, `${label} là bắt buộc.`);
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw httpError(400, `${label} phải là số từ ${min} đến ${max}.`);
    }
    return number;
}

function textField(value, label, maxLength, { required = false } = {}) {
    if (typeof value !== 'string') {
        if (required) throw httpError(400, `${label} là bắt buộc.`);
        return '';
    }
    const text = value.trim();
    if (required && !text) throw httpError(400, `${label} là bắt buộc.`);
    if (text.length > maxLength) throw httpError(400, `${label} không được vượt quá ${maxLength} ký tự.`);
    return text;
}

function rankRows(rows) {
    const ranked = rows.filter(row => row.score !== null).sort((a, b) => b.score - a.score);
    let previous = null;
    let rank = 0;
    for (let index = 0; index < ranked.length; index++) {
        const row = ranked[index];
        if (previous === null || Math.abs(previous - row.score) > 1e-9) rank = index + 1;
        row.rank = rank;
        row.rank_roman = ['I', 'II', 'III'][rank - 1] || String(rank);
        previous = row.score;
    }
    for (const row of rows) {
        if (row.score === null) {
            row.rank = null;
            row.rank_roman = '—';
        }
    }
}

function rangeData(startValue, endValue) {
    const start = isoDate(dateUtc(startValue));
    const end = isoDate(dateUtc(endValue));
    const expectedDays = (dateUtc(end) - dateUtc(start)) / 86400000 + 1;
    if (expectedDays < 1 || expectedDays > 32) throw httpError(400, 'Khoảng tổng hợp phải từ 1 đến 32 ngày.');
    const data = store.scores.filter(record => record.day >= start && record.day <= end);
    const units = store.units.map(unit => {
        const rows = data.filter(record => record.unit_id === unit.id);
        const daysFilled = new Set(rows.map(record => record.day)).size;
        const bases = rows.map(record => record.base);
        const avgBase = bases.length ? bases.reduce((sum, value) => sum + value, 0) / bases.length : null;
        const bonus = rows.reduce((sum, record) => sum + record.bonus, 0);
        const penalty = rows.reduce((sum, record) => sum + record.penalty, 0);
        const score = avgBase === null ? null : avgBase + bonus - penalty;
        return {
            unit_id: unit.id,
            unit_name: unit.name,
            avg_base: avgBase,
            score,
            score_rounded: score === null ? null : Math.round(score),
            bonus,
            penalty,
            days_filled: daysFilled,
            complete: daysFilled === expectedDays,
            rank: null,
            rank_roman: '—'
        };
    });
    rankRows(units);
    return {
        start,
        end,
        expected_days: expectedDays,
        complete: units.length > 0 && units.every(unit => unit.complete),
        data,
        units
    };
}

function weekData(startValue) {
    const start = monday(startValue);
    return rangeData(start, addDays(start, 6));
}

function monthData(monthValue) {
    const month = validMonth(monthValue);
    const [year, monthNumber] = month.split('-').map(Number);
    const first = `${month}-01`;
    const lastDate = new Date(Date.UTC(year, monthNumber, 0));
    const last = isoDate(lastDate);
    let cursor = monday(first);
    const weeks = [];
    while (cursor <= last) {
        const thursday = addDays(cursor, 3);
        if (thursday >= first && thursday <= last) weeks.push(weekData(cursor));
        cursor = addDays(cursor, 7);
    }
    const units = store.units.map(unit => {
        const scores = weeks.map(week => week.units.find(row => row.unit_id === unit.id)?.score).filter(score => score != null);
        const score = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
        return {
            unit_id: unit.id,
            unit_name: unit.name,
            score,
            score_rounded: score === null ? null : Math.round(score),
            weeks_filled: scores.length,
            weeks_expected: weeks.length,
            complete: scores.length === weeks.length && weeks.length > 0,
            rank: null,
            rank_roman: '—'
        };
    });
    rankRows(units);
    return {
        month,
        start: weeks.length ? weeks[0].start : monday(first),
        end: weeks.length ? weeks[weeks.length - 1].end : last,
        weeks,
        units
    };
}

function defaultRemark(start) {
    return {
        week_start: start,
        positive: [],
        negative: [],
        pos_details: '',
        neg_details: '',
        recommendations: '',
        collective: '',
        individual: '',
        draft: '',
        generator: 'manual'
    };
}

function infoResponse() {
    return {
        version: '1.1.0',
        data_location: DATA_FILE,
        settings: store.settings,
        positive_keywords: DEFAULT_POSITIVE,
        negative_keywords: DEFAULT_NEGATIVE
    };
}

function geminiStatus() {
    return {
        configured: Boolean(volatileGeminiKey || process.env.GEMINI_API_KEY),
        preconfigured: Boolean(process.env.GEMINI_API_KEY),
        model: store.settings.gemini_model || 'gemini-2.5-flash'
    };
}

function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function buildDraft(input) {
    const positives = Array.isArray(input.positive) ? input.positive.map(value => textField(value, 'Từ khóa', 160)).filter(Boolean) : [];
    const negatives = Array.isArray(input.negative) ? input.negative.map(value => textField(value, 'Từ khóa', 160)).filter(Boolean) : [];
    const posDetails = textField(input.pos_details, 'Diễn biến ưu điểm', 5000);
    const negDetails = textField(input.neg_details, 'Diễn biến khuyết điểm', 5000);
    const recommendations = textField(input.recommendations, 'Kiến nghị', 5000);
    const collective = textField(input.collective, 'Nhận xét tập thể', 5000);
    const individual = textField(input.individual, 'Nhận xét cá nhân', 5000);
    const sections = [];
    if (collective) sections.push(collective);
    if (positives.length || posDetails) {
        sections.push(`Ưu điểm: ${[positives.join('; '), posDetails].filter(Boolean).join('. ')}.`);
    }
    if (negatives.length || negDetails) {
        sections.push(`Hạn chế: ${[negatives.join('; '), negDetails].filter(Boolean).join('. ')}.`);
    }
    if (individual) sections.push(`Cá nhân: ${individual}`);
    if (recommendations) sections.push(`Phương hướng, kiến nghị: ${recommendations}`);
    if (!sections.length) {
        sections.push('Chưa có nội dung nhận xét. Hãy chọn từ khóa hoặc bổ sung diễn biến thực tế trước khi soạn báo cáo.');
    }
    return sections.join('\n\n');
}

async function geminiGenerate(prompt, model) {
    const key = volatileGeminiKey || process.env.GEMINI_API_KEY;
    if (!key) throw httpError(503, 'Chưa cấu hình GEMINI_API_KEY hoặc khóa Gemini trong Cài đặt.');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(30000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw httpError(502, result.error?.message || `Gemini trả về lỗi HTTP ${response.status}.`);
    const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!text) throw httpError(502, 'Gemini không trả về nội dung nhận xét.');
    return text;
}

function wordDocument(startValue) {
    const settings = store.settings;
    const period = settings.period_start && settings.period_end
        ? rangeData(settings.period_start, settings.period_end)
        : weekData(startValue);
    const remark = store.remarks[monday(startValue)] || defaultRemark(monday(startValue));
    const title = settings.report_title || 'TỔNG HỢP';
    const tableRows = period.units.map(unit => `<tr><td>${htmlEscape(unit.unit_name)}</td><td>${unit.days_filled}/${period.expected_days}</td><td>${unit.avg_base === null ? '—' : unit.avg_base.toFixed(2)}</td><td>${unit.bonus.toFixed(2)}</td><td>${unit.penalty.toFixed(2)}</td><td>${unit.score === null ? '—' : unit.score.toFixed(2)}</td><td>${htmlEscape(unit.rank_roman)}</td></tr>`).join('');
    const details = htmlEscape(remark.draft || buildDraft(remark)).replace(/\n/g, '<br>');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#333}h1,h2,p{text-align:center}table{border-collapse:collapse;width:100%}th,td{border:1px solid #555;padding:6px}th{background:#ffcb3d}</style></head><body><h1>${htmlEscape(title)}</h1><p>${htmlEscape(settings.unit_title || '')}</p><p>${htmlEscape(settings.group_title || '')}</p><p>Từ ${period.start} đến ${period.end}</p><table><thead><tr><th>Đơn vị</th><th>Số ngày</th><th>TB điểm gốc</th><th>Cộng</th><th>Trừ</th><th>Tổng điểm</th><th>Hạng</th></tr></thead><tbody>${tableRows}</tbody></table><h2>Nhận xét</h2><p style="text-align:left">${details}</p><p style="text-align:right">${htmlEscape(settings.report_place || '')}, ngày ${new Date().toLocaleDateString('vi-VN')}</p></body></html>`;
    return Buffer.from(`\ufeff${html}`, 'utf8');
}

async function handleApi(req, res, url) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') validateLocalRequest(req);

    if (method === 'GET' && pathname === '/api/info') return jsonResponse(res, 200, infoResponse());
    if (method === 'GET' && pathname === '/api/units') return jsonResponse(res, 200, store.units);
    if (method === 'GET' && pathname === '/api/criteria') return jsonResponse(res, 200, store.criteria);
    if (method === 'GET' && pathname === '/api/gemini/settings') return jsonResponse(res, 200, geminiStatus());

    if (method === 'GET' && pathname === '/api/week') {
        const start = url.searchParams.get('start');
        if (!start) throw httpError(400, 'Thiếu ngày bắt đầu tuần.');
        return jsonResponse(res, 200, weekData(start));
    }
    if (method === 'GET' && pathname === '/api/month') {
        const month = url.searchParams.get('month');
        if (!month) throw httpError(400, 'Thiếu tháng cần tổng hợp.');
        return jsonResponse(res, 200, monthData(month));
    }
    if (method === 'GET' && pathname === '/api/remarks') {
        const week = url.searchParams.get('week');
        if (!week) throw httpError(400, 'Thiếu tuần cần lấy nhận xét.');
        return jsonResponse(res, 200, store.remarks[monday(week)] || defaultRemark(monday(week)));
    }
    if (method === 'GET' && pathname === '/api/export/backup') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="thi-dua-backup-${new Date().toISOString().slice(0, 10)}.json"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        return res.end(JSON.stringify({ exported_at: new Date().toISOString(), data: store }, null, 2));
    }
    if (method === 'GET' && pathname === '/api/export/word') {
        const start = url.searchParams.get('start');
        if (!start) throw httpError(400, 'Thiếu tuần cần xuất báo cáo.');
        const buffer = wordDocument(start);
        res.writeHead(200, {
            'Content-Type': 'application/msword; charset=utf-8',
            'Content-Disposition': `attachment; filename="bao-cao-thi-dua-${monday(start)}.doc"`,
            'Content-Length': buffer.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        return res.end(buffer);
    }

    if (method === 'POST' && pathname === '/api/scores') {
        const body = await readJson(req);
        const day = body.day;
        dateUtc(day);
        const unitId = Number(body.unit_id);
        if (!Number.isInteger(unitId) || !store.units.some(unit => unit.id === unitId)) {
            throw httpError(400, 'Đơn vị chấm điểm không hợp lệ.');
        }
        const mode = body.mode === 'components' ? 'components' : body.mode === 'total' ? 'total' : null;
        if (!mode) throw httpError(400, 'Cách nhập điểm không hợp lệ.');
        const bonus = numberField(body.bonus ?? 0, 'Điểm cộng', { min: 0, max: 2000 });
        const penalty = numberField(body.penalty ?? 0, 'Điểm trừ', { min: 0, max: 2000 });
        let components = {};
        let base;
        if (mode === 'components') {
            if (!body.components || typeof body.components !== 'object' || Array.isArray(body.components)) {
                throw httpError(400, 'Cần nhập điểm theo mục tiêu.');
            }
            const active = new Set(store.criteria.filter(item => item.active).map(item => item.code));
            for (const [code, value] of Object.entries(body.components)) {
                if (!active.has(code)) throw httpError(400, `Mục tiêu ${code} không hoạt động.`);
                components[code] = numberField(value, `${code}`, { min: 0, max: 2000 });
            }
            if (!Object.keys(components).length) throw httpError(400, 'Hãy nhập ít nhất một mục tiêu thi đua.');
            base = Object.values(components).reduce((sum, value) => sum + value, 0);
        } else {
            base = numberField(body.base, 'Điểm gốc', { min: 0, max: 100000 });
        }
        const record = {
            day,
            unit_id: unitId,
            mode,
            base,
            bonus,
            penalty,
            components,
            note: textField(body.note, 'Ghi chú', 5000)
        };
        const saved = await mutate(next => {
            const index = next.scores.findIndex(item => item.day === day && item.unit_id === unitId);
            if (index >= 0) next.scores[index] = record;
            else next.scores.push(record);
            next.scores.sort((a, b) => a.day.localeCompare(b.day) || a.unit_id - b.unit_id);
            return record;
        });
        return jsonResponse(res, 200, saved);
    }
    if (method === 'DELETE' && pathname === '/api/scores') {
        const day = url.searchParams.get('day');
        dateUtc(day);
        const unitId = Number(url.searchParams.get('unit_id'));
        const deleted = await mutate(next => {
            const before = next.scores.length;
            next.scores = next.scores.filter(item => item.day !== day || item.unit_id !== unitId);
            return before !== next.scores.length;
        });
        if (!deleted) throw httpError(404, 'Không tìm thấy điểm của đơn vị trong ngày đã chọn.');
        return jsonResponse(res, 200, { deleted: true });
    }
    if (method === 'POST' && pathname === '/api/remarks') {
        const body = await readJson(req);
        const start = monday(body.week_start);
        for (const key of ['positive', 'negative']) {
            if (body[key] !== undefined && (!Array.isArray(body[key]) || body[key].length > 100)) {
                throw httpError(400, `Danh sách ${key} không hợp lệ.`);
            }
        }
        const remark = {
            week_start: start,
            positive: (body.positive || []).map(value => textField(value, 'Từ khóa', 160, { required: true })),
            negative: (body.negative || []).map(value => textField(value, 'Từ khóa', 160, { required: true })),
            pos_details: textField(body.pos_details, 'Diễn biến ưu điểm', 5000),
            neg_details: textField(body.neg_details, 'Diễn biến khuyết điểm', 5000),
            recommendations: textField(body.recommendations, 'Kiến nghị', 5000),
            collective: textField(body.collective, 'Nhận xét tập thể', 5000),
            individual: textField(body.individual, 'Nhận xét cá nhân', 5000),
            draft: textField(body.draft, 'Dự thảo', 20000),
            generator: ['manual', 'template-rule', 'gemini-online'].includes(body.generator) ? body.generator : 'manual'
        };
        const saved = await mutate(next => {
            next.remarks[start] = remark;
            return remark;
        });
        return jsonResponse(res, 200, saved);
    }
    if (method === 'POST' && pathname === '/api/settings') {
        const body = await readJson(req);
        const settings = {
            unit_title: textField(body.unit_title, 'Tên đơn vị', 160),
            group_title: textField(body.group_title, 'Tổ/bộ phận', 160),
            report_title: textField(body.report_title, 'Tiêu đề báo cáo', 160),
            campaign_title: textField(body.campaign_title, 'Tên phong trào', 300),
            report_place: textField(body.report_place, 'Địa điểm', 160),
            period_start: body.period_start || '',
            period_end: body.period_end || '',
            gemini_model: store.settings.gemini_model || 'gemini-2.5-flash'
        };
        if (Boolean(settings.period_start) !== Boolean(settings.period_end)) {
            throw httpError(400, 'Cần nhập cả ngày bắt đầu và ngày kết thúc báo cáo, hoặc để trống cả hai.');
        }
        if (settings.period_start) {
            const start = dateUtc(settings.period_start);
            const end = dateUtc(settings.period_end);
            const days = (end - start) / 86400000 + 1;
            if (days < 1 || days > 32) throw httpError(400, 'Khoảng báo cáo phải từ 1 đến 32 ngày.');
        }
        const saved = await mutate(next => {
            next.settings = { ...next.settings, ...settings };
            return next.settings;
        });
        return jsonResponse(res, 200, saved);
    }
    if (method === 'POST' && pathname === '/api/units') {
        const body = await readJson(req);
        const name = textField(body.name, 'Phiên hiệu đơn vị', 100, { required: true });
        const result = await mutate(next => {
            if (next.units.some(unit => unit.name.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi'))) {
                throw httpError(409, 'Phiên hiệu đơn vị đã tồn tại.');
            }
            const unit = { id: next.nextUnitId++, name };
            next.units.push(unit);
            return unit;
        });
        return jsonResponse(res, 201, result);
    }
    if (method === 'POST' && pathname === '/api/units/update') {
        const body = await readJson(req);
        const id = Number(body.id);
        const name = textField(body.name, 'Phiên hiệu đơn vị', 100, { required: true });
        const result = await mutate(next => {
            const unit = next.units.find(item => item.id === id);
            if (!unit) throw httpError(404, 'Không tìm thấy đơn vị.');
            if (next.units.some(item => item.id !== id && item.name.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi'))) {
                throw httpError(409, 'Phiên hiệu đơn vị đã tồn tại.');
            }
            unit.name = name;
            return unit;
        });
        return jsonResponse(res, 200, result);
    }
    if (method === 'POST' && pathname === '/api/criteria') {
        const body = await readJson(req);
        const label = textField(body.label, 'Tên mục tiêu', 80, { required: true });
        const result = await mutate(next => {
            const numbers = next.criteria.map(item => Number(item.code.match(/^MT(\d+)$/)?.[1] || 0));
            const code = `MT${Math.max(0, ...numbers) + 1}`;
            const criterion = { code, label, active: true };
            next.criteria.push(criterion);
            return criterion;
        });
        return jsonResponse(res, 201, result);
    }
    if (method === 'POST' && pathname === '/api/criteria/update') {
        const body = await readJson(req);
        const code = textField(body.code, 'Mã mục tiêu', 20, { required: true });
        const label = textField(body.label, 'Tên mục tiêu', 80, { required: true });
        if (typeof body.active !== 'boolean') throw httpError(400, 'Trạng thái mục tiêu không hợp lệ.');
        const result = await mutate(next => {
            const criterion = next.criteria.find(item => item.code === code);
            if (!criterion) throw httpError(404, 'Không tìm thấy mục tiêu.');
            criterion.label = label;
            criterion.active = body.active;
            return criterion;
        });
        return jsonResponse(res, 200, result);
    }
    if (method === 'POST' && pathname === '/api/demo/load') {
        const body = await readJson(req);
        const selectedWeek = monday(body.week_start || isoDate(new Date()));
        const firstWeek = addDays(selectedWeek, -35);
        const positiveExamples = [DEFAULT_POSITIVE[1], DEFAULT_POSITIVE[5], DEFAULT_POSITIVE[7]];
        const negativeExamples = [DEFAULT_NEGATIVE[0], DEFAULT_NEGATIVE[4]];
        const demoRemarks = [];
        for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
            const start = addDays(firstWeek, weekIndex * 7);
            demoRemarks.push({
                start,
                remark: {
                    week_start: start,
                    positive: positiveExamples.slice(0, 2 + weekIndex % 2),
                    negative: negativeExamples.slice(0, 1 + weekIndex % 2),
                    pos_details: '[DỮ LIỆU GIẢ LẬP] Duy trì nền nếp, hoàn thành nội dung theo kế hoạch tuần.',
                    neg_details: '[DỮ LIỆU GIẢ LẬP] Một số thời điểm cần nhắc nhở thêm về tác phong.',
                    recommendations: '[DỮ LIỆU GIẢ LẬP] Tiếp tục duy trì nền nếp, tăng cường kiểm tra và khắc phục hạn chế.',
                    collective: '',
                    individual: '',
                    draft: '[DỮ LIỆU GIẢ LẬP] Kết quả được tạo để thử nghiệm phần mềm, không dùng làm báo cáo thực tế.',
                    generator: 'manual'
                }
            });
        }
        const result = await mutate(next => {
            let imported = 0;
            let existing = 0;
            const activeCodes = next.criteria.filter(item => item.active).map(item => item.code);
            const scoreProfiles = [932, 914, 897, 925, 906, 889, 918, 901];
            const dayVariation = [-7, 3, 0, 8, -4, 6, -2];
            const unitCount = next.units.length;

            for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
                const weekStart = addDays(firstWeek, weekIndex * 7);
                for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
                    const day = addDays(weekStart, dayIndex);
                    for (let unitIndex = 0; unitIndex < unitCount; unitIndex++) {
                        const unit = next.units[unitIndex];
                        if (next.scores.some(item => item.day === day && item.unit_id === unit.id)) {
                            existing++;
                            continue;
                        }

                        const variation = dayVariation[(dayIndex + unitIndex) % dayVariation.length];
                        const baseline = scoreProfiles[unitIndex % scoreProfiles.length]
                            + ((unitIndex * 13) % 11)
                            + weekIndex * 2
                            + variation;
                        const bonus = (dayIndex + unitIndex + weekIndex) % 3 === 0 ? 2 : 0;
                        const penalty = (dayIndex * 2 + unitIndex + weekIndex) % 5 === 0 ? 1 : 0;
                        const components = {};
                        let mode = 'total';
                        if (activeCodes.length) {
                            mode = 'components';
                            const share = Math.floor((baseline / activeCodes.length) * 100) / 100;
                            let assigned = 0;
                            activeCodes.forEach((code, index) => {
                                const value = index === activeCodes.length - 1
                                    ? Math.round((baseline - assigned) * 100) / 100
                                    : share;
                                components[code] = value;
                                assigned += value;
                            });
                        }
                        const note = (dayIndex + unitIndex + weekIndex) % 3 === 0
                            ? '[DỮ LIỆU GIẢ LẬP] Duy trì chế độ trực, vệ sinh khu vực và thực hiện nhiệm vụ đúng kế hoạch.'
                            : (dayIndex + unitIndex + weekIndex) % 4 === 0
                                ? '[DỮ LIỆU GIẢ LẬP] Cần nhắc nhở một số cá nhân bảo đảm tác phong đúng giờ.'
                                : '';
                        next.scores.push({
                            day,
                            unit_id: unit.id,
                            mode,
                            base: baseline,
                            bonus,
                            penalty,
                            components,
                            note
                        });
                        imported++;
                    }
                }
            }

            next.scores.sort((a, b) => a.day.localeCompare(b.day) || a.unit_id - b.unit_id);
            let remarksImported = 0;
            for (const { start, remark } of demoRemarks) {
                if (!next.remarks[start]) {
                    next.remarks[start] = remark;
                    remarksImported++;
                }
            }
            return { imported, existing, remarks_imported: remarksImported };
        });
        return jsonResponse(res, 200, {
            week_start: selectedWeek,
            first_week: firstWeek,
            weeks_generated: 6,
            ...result
        });
    }
    if (method === 'POST' && pathname === '/api/generate') {
        const body = await readJson(req);
        if (body.mode === 'gemini') {
            if (body.confirm_online !== true) throw httpError(400, 'Cần xác nhận gửi yêu cầu tới Gemini Online.');
            let details = '';
            if (body.include_details === true) {
                const start = monday(body.week_start);
                const dailyNotes = store.scores
                    .filter(record => record.day >= start && record.day <= addDays(start, 6) && record.note)
                    .map(record => `${record.day} · ${store.units.find(unit => unit.id === record.unit_id)?.name || 'Đơn vị'}: ${record.note}`)
                    .join('\n');
                details = `\nDiễn biến thực tế được phép sử dụng:\n${textField(body.pos_details, 'Diễn biến ưu điểm', 5000)}\n${textField(body.neg_details, 'Diễn biến khuyết điểm', 5000)}\nGhi chú theo ngày:\n${dailyNotes}`;
            }
            const prompt = `Soạn dự thảo nhận xét thi đua bằng tiếng Việt, khách quan, chỉ dùng dữ kiện người dùng cung cấp; không tự bịa thông tin. Ghi rõ ưu điểm, hạn chế và kiến nghị nếu có.\nƯu điểm: ${(body.positive || []).map(value => textField(value, 'Từ khóa', 160)).join('; ')}\nHạn chế: ${(body.negative || []).map(value => textField(value, 'Từ khóa', 160)).join('; ')}${details}\nKiến nghị: ${textField(body.recommendations, 'Kiến nghị', 5000)}\nTập thể: ${textField(body.collective, 'Nhận xét tập thể', 5000)}\nCá nhân: ${textField(body.individual, 'Nhận xét cá nhân', 5000)}`;
            const draft = await geminiGenerate(prompt, store.settings.gemini_model || 'gemini-2.5-flash');
            return jsonResponse(res, 200, { draft, generator: 'gemini-online' });
        }
        return jsonResponse(res, 200, { draft: buildDraft(body), generator: 'template-rule' });
    }
    if (method === 'POST' && pathname === '/api/gemini/settings') {
        const body = await readJson(req);
        const model = textField(body.model || store.settings.gemini_model, 'Tên mô hình Gemini', 100, { required: true });
        const key = textField(body.api_key, 'API key', 256);
        if (key) volatileGeminiKey = key;
        await mutate(next => {
            next.settings.gemini_model = model;
        });
        return jsonResponse(res, 200, geminiStatus());
    }
    if (method === 'POST' && pathname === '/api/gemini/clear-key') {
        volatileGeminiKey = '';
        return jsonResponse(res, 200, geminiStatus());
    }
    if (method === 'POST' && pathname === '/api/gemini/test') {
        const body = await readJson(req);
        if (body.confirm_online !== true) throw httpError(400, 'Cần xác nhận trước khi kết nối Gemini.');
        const model = store.settings.gemini_model || 'gemini-2.5-flash';
        await geminiGenerate('Chỉ trả lời: Kết nối thành công.', model);
        return jsonResponse(res, 200, { model, message: 'Dịch vụ Gemini đã phản hồi.' });
    }

    throw httpError(404, 'Không tìm thấy API được yêu cầu.');
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'style.css', 'logo_f9.png']);

async function serveStatic(req, res, url) {
    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        throw httpError(400, 'Đường dẫn không hợp lệ.');
    }
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(ROOT, `.${pathname}`);
    if (!PUBLIC_FILES.has(path.basename(file))) throw httpError(404, 'Không tìm thấy tệp.');
    if (!file.startsWith(`${ROOT}${path.sep}`) && file !== path.join(ROOT, 'index.html')) {
        throw httpError(403, 'Đường dẫn ngoài thư mục ứng dụng bị từ chối.');
    }
    let contents;
    try {
        contents = await fs.readFile(file);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') throw httpError(404, 'Không tìm thấy tệp.');
        throw error;
    }
    res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': contents.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : contents);
}

async function requestHandler(req, res) {
    try {
        const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
        if (url.pathname.startsWith('/api/')) {
            validateLocalRequest(req);
            return await handleApi(req, res, url);
        }
        if (!['GET', 'HEAD'].includes(req.method || '')) throw httpError(405, 'Phương thức không được hỗ trợ.');
        validateLocalRequest(req);
        return await serveStatic(req, res, url);
    } catch (error) {
        if (res.headersSent) {
            res.destroy(error);
            return;
        }
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status >= 500) console.error(error);
        return jsonResponse(res, status, { error: error.message || 'Lỗi nội bộ của dịch vụ.' });
    }
}

async function main() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        store = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new Error(`Không đọc được dữ liệu tại ${DATA_FILE}: ${error.message}`);
        }
        store = defaultStore();
        await persist(store);
    }
    if (!store || store.version !== 1 || !Array.isArray(store.units) || !Array.isArray(store.criteria) || !Array.isArray(store.scores)) {
        throw new Error(`Cấu trúc dữ liệu không hợp lệ tại ${DATA_FILE}. Hãy khôi phục từ bản sao lưu.`);
    }
    const server = http.createServer(requestHandler);
    server.listen(PORT, HOST, () => {
        console.log(`Bảng chấm điểm thi đua đang chạy tại http://${HOST}:${PORT}`);
        console.log(`Dữ liệu cục bộ: ${DATA_FILE}`);
        console.log('Chỉ cho phép kết nối từ máy tính này.');
    });
    server.on('error', error => {
        console.error(`Không khởi động được dịch vụ: ${error.message}`);
        process.exitCode = 1;
    });
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
