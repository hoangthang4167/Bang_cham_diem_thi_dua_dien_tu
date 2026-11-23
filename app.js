'use strict';
const $ = id => document.getElementById(id);
const unitsColors = ['#db292f', '#0579ca', '#e9a400', '#168b4f', '#8a54bd', '#0d9a9c'];
const TITLE = {
    dashboard: ['BẢNG ĐIỀU KHIỂN', 'Tổng quan thi đua', 'Theo dõi điểm số, đánh giá diễn biến và tổng hợp kết quả các đơn vị.'],
    entry: ['NHẬP DỮ LIỆU', 'Nhập điểm thi đua theo ngày', 'Chấm theo mục tiêu thi đua linh hoạt, thêm MT5, MT6 và đổi phiên hiệu đơn vị.'],
    analysis: ['PHÂN TÍCH SỐ LIỆU', 'So sánh kết quả thi đua', 'Biểu đồ ngày, tuần, tháng để đối chiếu mức tăng giảm khách quan.'],
    remarks: ['HỖ TRỢ SOẠN BÁO CÁO', 'Gợi ý nhận xét · Gemini tùy chọn', 'Chọn từ khóa ưu/khuyết điểm, nhập diễn biến và soạn nhận xét theo mẫu báo cáo.'],
    settings: ['CẤU HÌNH NỘI BỘ', 'Cài đặt và lưu trữ', 'Quản lý đơn vị, Gemini Online tùy chọn và sao lưu dữ liệu.']
};
const state = {
    auth: null,
    view: 'dashboard',
    weekStart: '',
    month: '',
    units: [],
    criteria: [],
    week: null,
    monthData: null,
    info: null,
    entries: [],
    analysisPeriod: 'day',
    positives: new Set(),
    negatives: new Set(),
    remarks: null,
    loading: false,
    gemini: null
};
const LOCAL_AUTH_KEY = 'thi_dua_local_account_v1';
const LOCAL_SESSION_KEY = 'thi_dua_local_session_v1';

function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}
function fromBase64(value) {
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function hashPassword(password, salt) {
    if (window.crypto?.subtle) {
        const source = new TextEncoder().encode(salt + ':' + password);
        const digest = await crypto.subtle.digest('SHA-256', source);
        return toBase64(new Uint8Array(digest));
    }
    let hash = 2166136261;
    const source = salt + ':' + password;
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
function getLocalAccount() {
    try {
        return JSON.parse(localStorage.getItem(LOCAL_AUTH_KEY));
    } catch (_) {
        return null;
    }
}
function localISO(d) {
    const a = new Date(d);
    return [a.getFullYear(), String(a.getMonth() + 1).padStart(2, '0'), String(a.getDate()).padStart(2, '0')].join('-');
}
function addDays(v, n) {
    const [y,m,d] = v.split('-').map(Number);
    return localISO(new Date(y,m - 1,d + n));
}
function monday(v) {
    const [y,m,d] = v.split('-').map(Number);
    const n = new Date(y,m - 1,d);
    return addDays(v, -((n.getDay() + 6) % 7));
}
function formatDay(v) {
    if (!v)
        return '';
    const [y,m,d] = v.split('-');
    return `${d}/${m}/${y}`;
}
function formatShort(v) {
    if (!v)
        return '';
    const [y,m,d] = v.split('-');
    return `${d}/${m}`;
}
function formatNum(v, n=0) {
    return v === null || v === undefined ? '—' : Number(v).toLocaleString('vi-VN', {
        maximumFractionDigits: n,
        minimumFractionDigits: n
    });
}
function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}
function msg(text, type='info') {
    const node = $('notice');
    node.textContent = text;
    node.className = 'notice ' + type;
    node.hidden = false;
    clearTimeout(window._noticeTimeout);
    window._noticeTimeout = setTimeout( () => node.hidden = true, 8500);
}
async function api(path, options={}) {
    const opts = {
        credentials: 'same-origin',
        ...options
    };
    if (options.body && typeof options.body !== 'string')
        opts.body = JSON.stringify(options.body);
    if (opts.body)
        opts.headers = {
            'Content-Type': 'application/json',
            ...(opts.headers || {})
        };
    if (opts.method && opts.method.toUpperCase() !== 'GET' && state.auth?.csrf) {
        opts.headers = {
            'X-CSRF-Token': state.auth.csrf,
            ...(opts.headers || {})
        };
    }
    let response;
    try {
        response = await fetch(path, opts);
    } catch (e) {
        throw Error('Không kết nối được dịch vụ ứng dụng. Hãy chạy "npm start" trong thư mục dự án rồi mở http://127.0.0.1:4173.');
    }
    let result;
    try {
        result = await response.json();
    } catch (e) {
        if (path.startsWith('/api/')) {
            throw Error('Địa chỉ hiện tại không có API của ứng dụng. Có thể bạn đang dùng Live Server. Hãy dừng Live Server, chạy "npm start" trong thư mục dự án rồi mở http://127.0.0.1:4173.');
        }
        throw Error('Máy chủ trả về dữ liệu không hợp lệ.');
    }
    if (!response.ok) {
        if (response.status === 401 && !path.startsWith('/api/auth/'))
            showAuth(false);
        throw Error(result.error || `Lỗi ${response.status}`);
    }
    return result;
}
function setView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== 'view-' + view);
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    $('page-eyebrow').textContent = TITLE[view][0];
    $('page-title').textContent = TITLE[view][1];
    $('page-subtitle').textContent = TITLE[view][2];
    $('crumb-current').textContent = TITLE[view][1];
    if (view === 'analysis')
        updateAnalysis().catch(e => msg(e.message, 'error'));
    if (view === 'settings')
        renderSettings();
    window.scrollTo({
        top: 0,
        behavior: 'instant'
    });
}
function unitColor(index) {
    return unitsColors[index % unitsColors.length];
}
function rangeText() {
    return `${formatShort(state.weekStart)} – ${formatDay(addDays(state.weekStart, 6))}`;
}
async function refresh() {
    state.weekStart = monday($('globalWeek').value || localISO(new Date()));
    $('globalWeek').value = state.weekStart;
    const [week,remark] = await Promise.all([api('/api/week?start=' + state.weekStart), api('/api/remarks?week=' + state.weekStart)]);
    state.week = week;
    state.entries = week.data;
    state.remarks = remark;
    state.positives = new Set(remark.positive || []);
    state.negatives = new Set(remark.negative || []);
    updateRemarksUI();
    renderDashboard();
    renderEntryRows();
    renderWeeklyLedger();
    $('entryProgress').textContent = state.entries.length + '/' + (state.units.length * 7) + ' lượt';
    if (state.view === 'analysis')
        await updateAnalysis();
    if (!$('scoreDay').value || $('scoreDay').value < state.weekStart || $('scoreDay').value > week.end) {
        $('scoreDay').value = state.weekStart;
    }
}
function getWeekScores() {
    return (state.week?.units || []).filter(u => u.score != null).sort( (a, b) => b.score - a.score);
}
function renderDashboard() {
    const week = state.week;
    if (!week)
        return;
    const filled = week.data.length
      , total = 7 * state.units.length;
    const scored = getWeekScores();
    const leader = scored[0];
    const avg = scored.length ? scored.reduce( (a, b) => a + b.score, 0) / scored.length : null;
    const avgComplete = state.units.length && week.complete;
    const kpis = [['Điểm trung bình các đơn vị', avg != null ? formatNum(avg, 1) : '—', avgComplete ? 'Đã đủ dữ liệu tuần' : 'Tạm tính theo dữ liệu đã nhập', '◇'], ['Đơn vị dẫn đầu', leader ? escapeHtml(leader.unit_name) : '—', leader ? formatNum(leader.score_rounded) + ' điểm · Hạng I' : 'Chưa có điểm', '★'], ['Số lượt đã nhập', `${filled}/${total}`, filled === total ? 'Đã hoàn thành 7 ngày' : 'Còn ' + (total - filled) + ' lượt chưa nhập', '▦'], ['Điểm thưởng / điểm trừ', `${formatNum(week.units.reduce( (x, u) => x + u.bonus, 0))} / ${formatNum(week.units.reduce( (x, u) => x + u.penalty, 0))}`, 'Tổng cộng trong tuần', '⊕']];
    $('kpis').innerHTML = kpis.map(k => `<div class="kpi"><div class="kpi-top">${k[0]}</div><div class="kpi-value">${k[1]}</div><div class="kpi-sub">${k[2]}</div><span class="kpi-icon">${k[3]}</span></div>`).join('');
    $('dashboardDemoCallout').hidden = Boolean(week.complete);
    $('dashboardDemoProgress').textContent = `Đã nhập ${filled} trên ${total} lượt cho tuần ${formatDay(week.start)} – ${formatDay(week.end)}.`;
    $('dashRange').textContent = rangeText();
    const conf = state.info?.settings || {};
    $('reportBannerTitle').textContent = conf.report_title || 'TỔNG HỢP';
    $('heroCampaign').textContent = conf.campaign_title || 'Thượng úy Phan Đình Tuấn - Chính trị viên Đại đội 9';
    $('reportBannerRange').textContent = (conf.unit_title || 'ĐẠI ĐỘI 9') + ' · ' + (conf.period_start && conf.period_end ? formatDay(conf.period_start) + ' – ' + formatDay(conf.period_end) : rangeText());
    renderDayChart('dayChart', 'chartLegend');
    $('ranks').innerHTML = scored.length ? scored.map(r => `<div class="rank-row"><div class="rank-number">${escapeHtml(r.rank_roman)}</div><div class="rank-meta"><b>${escapeHtml(r.unit_name)}</b><small>${r.days_filled}/7 ngày${r.complete ? ' · Đã đủ ngày' : ' · Tạm tính'}</small></div><div class="rank-points">${formatNum(r.score_rounded)}</div></div>`).join('') : '<div class="chart-empty">Chưa có điểm thi đua trong tuần.<br>Vào “Nhập điểm theo ngày” để bắt đầu.</div>';
    const insight = [];
    if (!scored.length) {
        insight.push('Chưa đủ dữ liệu để phân tích. Có thể nạp tuần mẫu ở Cài đặt để dùng thử.');
    } else {
        insight.push(`${escapeHtml(scored[0].unit_name)} dẫn đầu với ${formatNum(scored[0].score_rounded)} điểm tuần (${scored[0].days_filled}/7 ngày).`);
        if (scored.length > 1) {
            const last = scored.at(-1)
              , delta = scored[0].score - last.score;
            insight.push(`Chênh lệch điểm giữa nhóm dẫn đầu và cuối bảng: ${formatNum(delta, 1)} điểm.`);
        }
        const all = week.data.map(x => x.base + x.bonus - x.penalty);
        if (all.length > 1) {
            insight.push(`Điểm ngày cao nhất: ${formatNum(Math.max(...all), 1)}; thấp nhất: ${formatNum(Math.min(...all), 1)}.`);
        }
        if (!week.complete)
            insight.push('Cảnh báo: tuần chưa đủ điểm của mọi đơn vị. Không dùng kết quả tạm tính để kết luận chính thức.');
        insight.push('Thông tin về tác phong, tư tưởng, vi phạm hoặc thành tích chỉ được đưa vào nhận xét khi cán bộ lựa chọn từ khóa hoặc nhập ghi chú thực tế.');
    }
    $('quickAnalysis').innerHTML = insight.map( (text, i) => `<div class="insight"><strong>${i + 1}.</strong> ${text}</div>`).join('');
}
function drawLineChart(container, legendId, days, units, values) {
    const svg = $(container)
      , leg = $(legendId);
    let count = 0;
    for (const u of units)
        count += (values[u.id] || []).filter(v => v != null).length;
    if (!count) {
        svg.innerHTML = '<div class="chart-empty">Chưa có dữ liệu để vẽ biểu đồ.<br>Điểm sẽ tự xuất hiện sau khi nhập.</div>';
        leg.innerHTML = '';
        return;
    }
    const W = 760
      , H = 290
      , ml = 48
      , mr = 21
      , mt = 20
      , mb = 42
      , pW = W - ml - mr
      , pH = H - mt - mb;
    const all = Object.values(values).flat().filter(v => v != null);
    const ymin = Math.max(0, Math.floor((Math.min(...all) - 35) / 50) * 50)
      , ymax = Math.ceil((Math.max(...all) + 35) / 50) * 50;
    const span = Math.max(ymax - ymin, 50);
    const x = i => ml + (days.length === 1 ? pW / 2 : i * pW / (days.length - 1));
    const y = v => mt + (ymax - v) * pH / span;
    let content = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Biểu đồ so sánh điểm thi đua">`;
    for (let k = 0; k <= 4; k++) {
        let v = ymin + span * k / 4
          , yy = y(v);
        content += `<line x1="${ml}" y1="${yy}" x2="${W - mr}" y2="${yy}" stroke="#e5ebe4" stroke-width="1"/><text x="${ml - 10}" y="${yy + 4}" text-anchor="end" fill="#87958a" font-size="11">${Math.round(v)}</text>`;
    }
    days.forEach( (d, i) => content += `<text x="${x(i)}" y="${H - 13}" text-anchor="middle" fill="#86958a" font-size="11">${escapeHtml(d)}</text>`);
    units.forEach( (unit, idx) => {
        const color = unitColor(idx)
          , v = values[unit.id] || [];
        let segment = [];
        function flush() {
            if (segment.length)
                content += `<polyline points="${segment.join(' ')}" fill="none" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
            segment = [];
        }
        v.forEach( (score, i) => {
            if (score == null) {
                flush();
                return;
            }
            segment.push(`${x(i)},${y(score)}`);
        }
        );
        flush();
        v.forEach( (score, i) => {
            if (score != null) {
                content += `<circle cx="${x(i)}" cy="${y(score)}" r="3.9" fill="#fff" stroke="${color}" stroke-width="2.5"><title>${escapeHtml(unit.name)}: ${formatNum(score, 1)} điểm</title></circle>`;
            }
        }
        );
    }
    );
    svg.innerHTML = content + '</svg>';
    leg.innerHTML = units.map( (u, i) => `<span class="legend-item"><i class="legend-dot" style="background:${unitColor(i)}"></i>${escapeHtml(u.name)}</span>`).join('');
}
function renderDayChart(chart='dayChart', legend='chartLegend') {
    const start = state.weekStart
      , days = Array.from({
        length: 7
    }, (_, i) => addDays(start, i));
    const values = {};
    state.units.forEach(u => values[u.id] = days.map(day => {
        let r = state.entries.find(x => x.day === day && x.unit_id === u.id);
        return r ? Math.round((r.base + r.bonus - r.penalty) * 100) / 100 : null;
    }
    ));
    const labels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'];
    drawLineChart(chart, legend, labels, state.units, values);
}
function activeCriteria() {
    return state.criteria.filter(c => c.active);
}
function renderCriteriaInputs() {
    $('criteriaInputs').innerHTML = activeCriteria().map(c => `<label>${escapeHtml(c.code)} <small>${escapeHtml(c.label !== c.code ? c.label : '')}</small><input data-mt-code="${escapeHtml(c.code)}" type="number" min="0" max="2000" step="0.01" placeholder="—"></label>`).join('');
    document.querySelectorAll('[data-mt-code]').forEach(input => input.addEventListener('input', updatePreviewTotal));
    updatePreviewTotal();
}
function updatePreviewTotal() {
    let sum = 0
      , n = 0;
    document.querySelectorAll('[data-mt-code]').forEach(input => {
        if (input.value !== '') {
            sum += Number(input.value);
            n++;
        }
    }
    );
    $('calculatedBase').textContent = n ? 'Tổng điểm ' + n + ' MT đã nhập: ' + formatNum(sum, 2) : 'Nhập điểm cho các MT áp dụng; MT không áp dụng có thể để trống.';
}
function selectScoreRow(day, id) {
    let rec = state.entries.find(x => x.day === day && x.unit_id === id);
    $('scoreDay').value = day;
    $('scoreUnit').value = id;
    document.querySelector(`input[name="scoreMode"][value="${rec ? rec.mode : 'total'}"]`).checked = true;
    $('scoreBase').value = rec?.base ?? '';
    document.querySelectorAll('[data-mt-code]').forEach(input => {
        input.value = rec?.components?.[input.dataset.mtCode] ?? '';
    }
    );
    $('scoreBonus').value = rec?.bonus ?? 0;
    $('scorePenalty').value = rec?.penalty ?? 0;
    $('scoreNote').value = rec?.note ?? '';
    const archive = Object.entries(rec?.components || {}).filter( ([code]) => !activeCriteria().some(c => c.code === code));
    $('criteriaArchiveNotice').hidden = !archive.length;
    $('criteriaArchiveNotice').textContent = archive.length ? 'Điểm MT đã ẩn vẫn được giữ nguyên: ' + archive.map( ([k,v]) => k + ' = ' + formatNum(v, 2)).join(', ') : '';
    updatePreviewTotal();
    toggleScoreMode();
    $('view-entry').scrollIntoView({
        block: 'start',
        behavior: 'smooth'
    });
}
function toggleScoreMode() {
    let c = document.querySelector('input[name="scoreMode"]:checked').value === 'components';
    $('totalFields').hidden = c;
    $('componentFields').hidden = !c;
}
function renderEntryRows() {
    let active = activeCriteria()
      , codes = active.map(c => c.code);
    // Historical values are included for visibility even when their criterion was disabled.
    let historical = state.criteria.filter(c => !c.active && state.entries.some(r => r.components?.[c.code] != null));
    let cols = [...active, ...historical];
    $('entryCols').innerHTML = '<th>Thứ / Ngày</th><th>Đơn vị</th>' + cols.map(c => `<th class="right" title="${escapeHtml(c.label)}">${escapeHtml(c.code)}${c.active ? '' : ' *'}</th>`).join('') + '<th class="right">Cộng</th><th class="right">Trừ</th><th class="right">Tổng điểm</th><th>Hạng ngày</th>';
    const lines = [];
    for (let d = 0; d < 7; d++) {
        let day = addDays(state.weekStart, d);
        const dayRows = state.units.map(u => {
            let rec = state.entries.find(x => x.day === day && x.unit_id === u.id);
            return {
                unit_id: u.id,
                score: rec ? rec.base + rec.bonus - rec.penalty : null
            };
        }
        ).filter(x => x.score != null).sort( (a, b) => b.score - a.score);
        let last = null
          , rank = 0
          , ranks = {};
        dayRows.forEach( (x, i) => {
            if (last === null || Math.abs(last - x.score) > 1e-9)
                rank = i + 1;
            last = x.score;
            ranks[x.unit_id] = rank;
        }
        );
        for (let j = 0; j < state.units.length; j++) {
            let u = state.units[j]
              , rec = state.entries.find(x => x.day === day && x.unit_id === u.id);
            const v = rec ? rec.base + rec.bonus - rec.penalty : null;
            const rank = ranks[u.id];
            const dt = new Date(day + 'T12:00:00');
            const label = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][dt.getDay()];
            lines.push(`<tr class="clickable ${j === 0 ? 'day-start' : ''}" data-day="${day}" data-unit="${u.id}"><td class="date-cell">${label}<br><b>${formatShort(day)}</b></td><td class="unit-cell">${escapeHtml(u.name)}</td>` + cols.map(c => `<td class="right mt-cell">${rec?.components?.[c.code] != null ? formatNum(rec.components[c.code], 2) : '<span class="muted">—</span>'}</td>`).join('') + `<td class="right positive">${rec && rec.bonus ? formatNum(rec.bonus, 2) : '—'}</td><td class="right negative">${rec && rec.penalty ? formatNum(rec.penalty, 2) : '—'}</td><td class="right total-cell">${v === null ? '<span class="muted">Chưa nhập</span>' : formatNum(v, 2)}</td><td class="rank-cell">${rank ? (['I', 'II', 'III'][rank - 1] || rank) : '—'}</td></tr>`);
        }
    }
    $('entryRows').innerHTML = lines.join('');
    document.querySelectorAll('#entryRows tr').forEach(tr => tr.addEventListener('click', () => selectScoreRow(tr.dataset.day, Number(tr.dataset.unit))));
}
function renderWeeklyLedger() {
    let week = state.week;
    if (!week)
        return;
    let active = state.criteria.filter(c => c.active || state.entries.some(r => r.components?.[c.code] != null));
    $('weeklyLedgerRange').textContent = 'Từ ' + formatDay(week.start) + ' đến ' + formatDay(week.end) + ' · TB điểm nền + cộng – trừ';
    $('weeklyCols').innerHTML = '<th>Số ngày</th><th>Đơn vị</th>' + active.map(c => `<th class="right" title="${escapeHtml(c.label)}">${escapeHtml(c.code)}</th>`).join('') + '<th class="right">Cộng</th><th class="right">Trừ</th><th class="right">Tổng (TB)</th><th>Hạng</th>';
    $('weeklyRows').innerHTML = week.units.slice().sort( (a, b) => (a.rank || 999) - (b.rank || 999)).map(u => {
        let rows = state.entries.filter(r => r.unit_id === u.unit_id);
        const mtCells = active.map(c => {
            let vals = rows.map(r => r.components?.[c.code]).filter(x => x != null);
            return `<td class="right mt-cell">${vals.length ? formatNum(vals.reduce( (a, b) => a + b, 0) / vals.length, 2) : '—'}</td>`;
        }
        ).join('');
        return `<tr><td>${u.days_filled}/7</td><td class="unit-cell">${escapeHtml(u.unit_name)}</td>${mtCells}<td class="right positive">${formatNum(u.bonus)}</td><td class="right negative">${formatNum(u.penalty)}</td><td class="right total-cell">${formatNum(u.score_rounded)}</td><td class="rank-cell">${escapeHtml(u.rank_roman)}</td></tr>`;
    }
    ).join('');
}
function clearEntry() {
    $('entryForm').reset();
    $('scoreDay').value = state.weekStart;
    $('scoreBonus').value = 0;
    $('scorePenalty').value = 0;
    $('criteriaArchiveNotice').hidden = true;
    updatePreviewTotal();
    toggleScoreMode();
}
async function submitEntry(e) {
    e.preventDefault();
    let c = document.querySelector('input[name="scoreMode"]:checked').value;
    let data = {
        day: $('scoreDay').value,
        unit_id: Number($('scoreUnit').value),
        mode: c,
        base: $('scoreBase').value,
        bonus: $('scoreBonus').value || 0,
        penalty: $('scorePenalty').value || 0,
        note: $('scoreNote').value
    };
    if (c === 'components') {
        data.components = {};
        document.querySelectorAll('[data-mt-code]').forEach(el => {
            if (el.value !== '')
                data.components[el.dataset.mtCode] = el.value;
        }
        );
    }
    try {
        await api('/api/scores', {
            method: 'POST',
            body: data
        });
        $('globalWeek').value = monday(data.day);
        msg('Đã lưu điểm và cập nhật kết quả thi đua.');
        await refresh();
    } catch (e) {
        msg(e.message, 'error');
    }
}

function renderBarChart(container, legendId, labels, unitObjs, values) {
    const node = $(container)
      , leg = $(legendId);
    const v = Object.values(values).flat().filter(s => s != null);
    if (!v.length) {
        node.innerHTML = '<div class="chart-empty">Chưa có dữ liệu tuần/tháng để so sánh.</div>';
        leg.innerHTML = '';
        return;
    }
    const W = 760
      , H = 315
      , ml = 49
      , mr = 20
      , mt = 18
      , mb = 49
      , pW = W - ml - mr
      , pH = H - mt - mb;
    const ymin = Math.max(0, Math.floor((Math.min(...v) - 35) / 50) * 50)
      , ymax = Math.ceil((Math.max(...v) + 35) / 50) * 50
      , span = Math.max(50, ymax - ymin);
    const y = n => mt + (ymax - n) * pH / span;
    const gap = pW / labels.length
      , cluster = Math.min(72, gap * .76)
      , bw = cluster / Math.max(unitObjs.length, 1)
      , offs = (gap - cluster) / 2;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Biểu đồ so sánh điểm thi đua theo kỳ">`;
    for (let j = 0; j <= 4; j++) {
        let n = ymin + j * span / 4;
        let yy = y(n);
        s += `<line x1="${ml}" y1="${yy}" x2="${W - mr}" y2="${yy}" stroke="#e5ebe4"/><text x="${ml - 10}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#819189">${Math.round(n)}</text>`;
    }
    for (let i = 0; i < labels.length; i++) {
        s += `<text x="${ml + i * gap + gap / 2}" y="${H - 17}" text-anchor="middle" font-size="11" fill="#819189">${escapeHtml(labels[i])}</text>`;
        unitObjs.forEach( (u, k) => {
            let score = values[u.id]?.[i];
            if (score == null)
                return;
            let xx = ml + i * gap + offs + k * bw
              , yy = y(score)
              , h = mt + pH - yy;
            s += `<rect x="${xx}" y="${yy}" width="${Math.max(bw - 2, 3)}" height="${Math.max(h, 0)}" rx="2" fill="${unitColor(k)}"><title>${escapeHtml(u.name)}: ${formatNum(score, 1)} điểm</title></rect>`;
        }
        );
    }
    node.innerHTML = s + '</svg>';
    leg.innerHTML = unitObjs.map( (u, i) => `<span class="legend-item"><i class="legend-dot" style="background:${unitColor(i)}"></i>${escapeHtml(u.name)}</span>`).join('');
}
async function updateAnalysis() {
    let mode = state.analysisPeriod;
    $('monthControl').hidden = mode !== 'month';
    document.querySelectorAll('#analysisTabs button').forEach(b => b.classList.toggle('active', b.dataset.period === mode));
    if (mode === 'day') {
        $('analysisChartTitle').textContent = 'So sánh điểm theo ngày';
        $('analysisChartSub').textContent = rangeText();
        renderDayChart('analysisChart', 'analysisLegend');
        $('analysisTableTitle').textContent = 'Tổng kết tuần – xếp hạng';
        $('analysisTableCaption').textContent = 'Điểm tuần = TB điểm gốc mỗi ngày + tổng cộng – tổng trừ';
        renderWeeklySummaryTable(state.week.units, 'analysisTable');
        return;
    }
    if (mode === 'week') {
        $('analysisChartTitle').textContent = 'So sánh các tuần gần nhất';
        $('analysisChartSub').textContent = '6 tuần tính đến tuần đang chọn; có thể chọn tuần khác ở phía trên';
        const starts = Array.from({
            length: 6
        }, (_, i) => addDays(state.weekStart, (i - 5) * 7));
        let weeks = await Promise.all(starts.map(start => api('/api/week?start=' + start)));
        let scores = {};
        state.units.forEach(u => scores[u.id] = weeks.map(w => w.units.find(r => r.unit_id === u.id)?.score ?? null));
        renderBarChart('analysisChart', 'analysisLegend', starts.map(x => formatShort(x)), state.units, scores);
        $('analysisTableTitle').textContent = 'Kết quả 6 tuần gần nhất';
        $('analysisTableCaption').textContent = 'Các tuần chưa đủ 7 ngày chỉ có giá trị tạm tính';
        $('analysisTable').innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Tuần</th>${state.units.map(u => `<th class="right">${escapeHtml(u.name)}</th>`).join('')}</tr></thead><tbody>` + weeks.map(w => `<tr><td>${formatShort(w.start)} – ${formatShort(w.end)}</td>${state.units.map(u => {
            let s = w.units.find(x => x.unit_id === u.id);
            return `<td class="right">${formatNum(s?.score_rounded)} ${s && s.score != null && !s.complete ? '<span class="flag">Tạm</span>' : ''}</td>`;
        }
        ).join('')}</tr>`).join('') + '</tbody></table></div>';
        return;
    }
    let month = $('selectedMonth').value || state.month;
    state.month = month;
    let data = await api('/api/month?month=' + month);
    state.monthData = data;
    $('analysisChartTitle').textContent = 'So sánh điểm các tuần trong tháng ' + month.split('-').reverse().join('/');
    $('analysisChartSub').textContent = `Gồm ${data.weeks.length} tuần liên tục (${formatDay(data.start)} – ${formatDay(data.end)})`;
    let values = {};
    state.units.forEach(u => values[u.id] = data.weeks.map(w => w.units.find(x => x.unit_id === u.id)?.score ?? null));
    renderBarChart('analysisChart', 'analysisLegend', data.weeks.map( (_, i) => 'Tuần ' + (i + 1)), state.units, values);
    $('analysisTableTitle').textContent = 'Điểm tháng – trung bình các tuần';
    $('analysisTableCaption').textContent = 'Một tuần thuộc tháng nếu ngày thứ Năm của tuần nằm trong tháng đó (theo dạng bảng tháng mẫu).';
    renderWeeklySummaryTable(data.units, 'analysisTable', true);
}
function renderWeeklySummaryTable(data, element, monthly=false) {
    const rows = [...data].sort( (a, b) => a.rank - b.rank);
    $(element).innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Đơn vị</th>' + (monthly ? '<th class="right">Số tuần</th>' : '<th class="right">TB điểm gốc</th><th class="right">Điểm cộng</th><th class="right">Điểm trừ</th><th class="right">Số ngày</th>') + '<th class="right">Điểm ' + (monthly ? 'tháng' : 'tuần') + '</th><th class="right">Xếp hạng</th></tr></thead><tbody>' + rows.map(r => `<tr><td><b>${escapeHtml(r.unit_name)}</b></td>` + (monthly ? `<td class="right">${r.weeks_filled}/${r.weeks_expected}</td>` : `<td class="right">${formatNum(r.avg_base, 2)}</td><td class="right positive">+${formatNum(r.bonus)}</td><td class="right negative">-${formatNum(r.penalty)}</td><td class="right">${r.days_filled}/7</td>`) + `<td class="right"><b>${formatNum(r.score_rounded)}</b></td><td class="right rank">${escapeHtml(r.rank_roman || '—')}${r.score != null && !r.complete ? ' <span class="flag">Tạm</span>' : ''}</td></tr>`).join('') + '</tbody></table></div>';
}
function updateRemarksUI() {
    const r = state.remarks || {};
    $('positiveDetails').value = r.pos_details || '';
    $('negativeDetails').value = r.neg_details || '';
    $('recommendation').value = r.recommendations || '';
    $('collective').value = r.collective || '';
    $('individual').value = r.individual || '';
    $('draftText').value = r.draft || '';
    $('editorStatus').textContent = r.draft ? (r.generator === 'ai-offline' ? 'AI Offline' : r.generator === 'gemini-online' ? 'Gemini Online' : 'Đã lưu · soạn tự động') : 'Chưa tạo';
    renderChips('positive');
    renderChips('negative');
}
function renderChips(type) {
    const isPos = type === 'positive';
    const set = isPos ? state.positives : state.negatives;
    const list = isPos ? state.info.positive_keywords : state.info.negative_keywords;
    const all = [...list, ...[...set].filter(x => !list.includes(x))];
    const node = $(isPos ? 'positiveKeywords' : 'negativeKeywords');
    node.innerHTML = all.map( (str, i) => `<button type="button" class="keyword-chip ${type} ${set.has(str) ? 'selected' : ''}" data-index="${i}" title="${set.has(str) ? 'Bỏ chọn' : 'Chọn'}">${set.has(str) ? '✓ ' : '+ '}${escapeHtml(str)}</button>`).join('');
    node.querySelectorAll('.keyword-chip').forEach(button => button.addEventListener('click', () => {
        const value = all[Number(button.dataset.index)];
        if (set.has(value))
            set.delete(value);
        else
            set.add(value);
        renderChips(type);
    }
    ));
    $(isPos ? 'positiveCount' : 'negativeCount').textContent = set.size;
}
function addCustomKeyword(type) {
    let isPos = type === 'positive'
      , input = $(isPos ? 'customPositive' : 'customNegative');
    let value = input.value.trim();
    if (!value) {
        input.focus();
        return;
    }
    if (value.length > 160) {
        msg('Từ khóa tối đa 160 ký tự.', 'warning');
        return;
    }
    (isPos ? state.positives : state.negatives).add(value);
    input.value = '';
    renderChips(type);
    msg('Đã thêm từ khóa ' + (isPos ? 'ưu điểm' : 'khuyết điểm') + '.');
}
function remarkPayload() {
    return {
        week_start: state.weekStart,
        positive: [...state.positives],
        negative: [...state.negatives],
        pos_details: $('positiveDetails').value,
        neg_details: $('negativeDetails').value,
        recommendations: $('recommendation').value,
        collective: $('collective').value,
        individual: $('individual').value,
        draft: $('draftText').value,
        generator: state.remarks?.generator || 'manual'
    };
}
async function saveRemarks() {
    const obj = await api('/api/remarks', {
        method: 'POST',
        body: remarkPayload()
    });
    state.remarks = obj;
    $('editorStatus').textContent = 'Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN');
    msg('Đã lưu từ khóa và nội dung nhận xét của tuần ' + formatDay(state.weekStart) + '.');
}
async function generate(mode) {
    const button = $(mode === 'ai' ? 'draftAI' : mode === 'gemini' ? 'draftGemini' : 'draftTemplate');
    if (mode === 'gemini' && !$('approveCloud').checked) {
        msg('Cần xác nhận được phép gửi dữ liệu tới Gemini Online.', 'error');
        return;
    }
    if (mode === 'gemini' && !state.gemini?.configured) {
        msg('Gemini chưa được cấu hình trong bộ cài này. Vào Cài đặt để nhập API key.', 'error');
        return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = mode === 'gemini' ? 'Đang kết nối Gemini…' : mode === 'ai' ? 'Đang khởi tạo AI…' : 'Đang soạn nhận xét…';
    try {
        const input = {
            ...remarkPayload(),
            mode,
            confirm_online: mode === 'gemini' && $('approveCloud').checked,
            include_details: mode === 'gemini' && $('sendNotes').checked
        };
        const obj = await api('/api/generate', {
            method: 'POST',
            body: input
        });
        $('draftText').value = obj.draft;
        state.remarks = {
            ...input,
            draft: obj.draft,
            generator: obj.generator
        };
        const names = {
            'gemini-online': 'Gemini Online',
            'ai-offline': 'AI Offline',
            'template-rule': 'Gợi ý tự động Offline'
        };
        $('editorStatus').textContent = 'Được tạo bằng ' + (names[obj.generator] || 'trình soạn');
        msg('Đã tạo dự thảo. Bạn cần kiểm tra và chỉnh sửa trước khi đưa vào báo cáo.');
    } catch (e) {
        msg(e.message, 'error');
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}
async function exportWord() {
    try {
        await saveRemarks();
        window.location.href = '/api/export/word?start=' + encodeURIComponent(state.weekStart);
        msg('Đã yêu cầu xuất báo cáo Word.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
function renderUnitManager() {
    $('unitManager').innerHTML = state.units.map(u => `<div class="manager-row" data-unit-id="${u.id}"><span class="manager-index">#${u.id}</span><input data-unit-name="${u.id}" maxlength="100" value="${escapeHtml(u.name)}" aria-label="Phiên hiệu đơn vị ${u.id}"><button class="btn btn-outline" type="button" data-save-unit="${u.id}">Lưu phiên hiệu</button></div>`).join('');
}
function renderCriteriaManager() {
    $('criteriaManager').innerHTML = state.criteria.map(c => `<div class="manager-row ${c.active ? '' : 'manager-inactive'}" data-code="${escapeHtml(c.code)}"><span class="manager-index">${escapeHtml(c.code)}</span><input data-label-code="${escapeHtml(c.code)}" maxlength="80" value="${escapeHtml(c.label)}" aria-label="Tên mục tiêu ${escapeHtml(c.code)}"><button class="btn btn-outline" type="button" data-save-criterion="${escapeHtml(c.code)}">Đổi tên</button><button class="btn ${c.active ? 'btn-danger-outline' : 'btn-outline'}" type="button" data-toggle-criterion="${escapeHtml(c.code)}">${c.active ? 'Ẩn MT' : 'Bật MT'}</button></div>`).join('');
}
function renderSettings() {
    const s = state.info?.settings;
    if (!s)
        return;
    $('unitTitle').value = s.unit_title || '';
    $('groupTitle').value = s.group_title || '';
    $('reportTitle').value = s.report_title || 'TỔNG HỢP';
    $('campaignTitle').value = s.campaign_title || '';
    $('reportPlace').value = s.report_place || '';
    $('periodStart').value = s.period_start || '';
    $('periodEnd').value = s.period_end || '';
    renderUnitManager();
    renderCriteriaManager();
    $('geminiModel').value = state.gemini?.model || 'gemini-3.5-flash';
    $('geminiStatus').textContent = state.gemini?.preconfigured ? 'Đã cấu hình GEMINI_API_KEY trong môi trường dịch vụ.' : state.gemini?.configured ? 'Khóa chỉ được giữ trong bộ nhớ dịch vụ đến khi tắt ứng dụng.' : 'Chưa có API key. Chấm điểm và báo cáo vẫn hoạt động hoàn toàn Offline.';
    $('dataLocation').textContent = state.info.data_location;
    $('appVersion').textContent = state.info.version;
}
async function saveSettings(e) {
    e.preventDefault();
    try {
        state.info.settings = await api('/api/settings', {
            method: 'POST',
            body: {
                unit_title: $('unitTitle').value,
                group_title: $('groupTitle').value,
                report_title: $('reportTitle').value,
                campaign_title: $('campaignTitle').value,
                report_place: $('reportPlace').value,
                period_start: $('periodStart').value,
                period_end: $('periodEnd').value,
                gemini_model: state.gemini?.model || 'gemini-3.5-flash'
            }
        });
        renderDashboard();
        msg('Đã lưu tên đơn vị cấp trên, tiêu đề và ngày báo cáo.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
async function initCriteria() {
    state.criteria = await api('/api/criteria');
    renderCriteriaInputs();
}
async function refreshConfig() {
    await initUnits();
    await initCriteria();
    await refresh();
    renderSettings();
}
async function renameUnitFromUI(id) {
    const input = document.querySelector(`[data-unit-name="${id}"]`);
    try {
        let r = await api('/api/units/update', {
            method: 'POST',
            body: {
                id,
                name: input.value.trim()
            }
        });
        await refreshConfig();
        msg('Đã đổi phiên hiệu thành ' + r.name + '. Lịch sử điểm vẫn giữ nguyên.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
async function addCriterion() {
    try {
        let result = await api('/api/criteria', {
            method: 'POST',
            body: {
                label: $('newCriterion').value.trim()
            }
        });
        $('newCriterion').value = '';
        await refreshConfig();
        msg('Đã tạo ' + result.code + ' và cập nhật bảng chấm điểm.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
async function changeCriterionFromUI(code, mode) {
    const c = state.criteria.find(x => x.code === code);
    if (!c)
        return;
    let label = document.querySelector(`[data-label-code="${code}"]`).value.trim();
    let active = mode === 'toggle' ? !Boolean(c.active) : Boolean(c.active);
    if (mode === 'toggle' && c.active && !confirm('Ẩn ' + code + ' khỏi các lần chấm mới? Lịch sử điểm cũ vẫn giữ nguyên.'))
        return;
    try {
        await api('/api/criteria/update', {
            method: 'POST',
            body: {
                code,
                label,
                active
            }
        });
        await refreshConfig();
        msg(code + ' đã được cập nhật.');
    } catch (e) {
        msg(e.message, 'error');
    }
}

async function saveGeminiSettings() {
    const key = $('geminiKey').value.trim();
    const model = $('geminiModel').value.trim();
    try {
        state.gemini = await api('/api/gemini/settings', {
            method: 'POST',
            body: {
                model,
                api_key: key
            }
        });
        $('geminiKey').value = '';
        renderSettings();
        msg('Đã lưu cài đặt Gemini. Chế độ Offline không thay đổi.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
async function testGeminiSettings() {
    if (!state.gemini?.configured) {
        msg('Hãy lưu API key Gemini trước khi thử kết nối.', 'error');
        return;
    }
    if (!confirm('Thử kết nối Gemini bằng một câu kiểm tra mẫu, KHÔNG gửi điểm hay ghi chú thi đua. Yêu cầu API có thể tính vào hạn mức sử dụng. Tiếp tục?'))
        return;
    const button = $('testGemini')
      , label = button.textContent;
    button.disabled = true;
    button.textContent = 'Đang thử kết nối…';
    try {
        const result = await api('/api/gemini/test', {
            method: 'POST',
            body: {
                confirm_online: true
            }
        });
        $('geminiStatus').textContent = '✓ Kết nối thành công với ' + result.model + '. ' + result.message;
        msg('Đã kết nối thành công Gemini API. Vào Gợi ý nhận xét / AI để sử dụng.');
    } catch (e) {
        $('geminiStatus').textContent = 'Thử kết nối thất bại: ' + e.message;
        msg(e.message, 'error');
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}
async function clearGeminiSettings() {
    if (!confirm('Xóa khóa Gemini do người dùng nhập? Khóa đã đóng gói sẵn (nếu có) vẫn còn.'))
        return;
    try {
        state.gemini = await api('/api/gemini/clear-key', {
            method: 'POST',
            body: {}
        });
        renderSettings();
        msg('Đã xóa khóa riêng. Nếu có khóa tích hợp sẵn, Gemini vẫn có thể hoạt động.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
async function addUnit() {
    let name = $('newUnit').value.trim();
    if (!name)
        return;
    try {
        await api('/api/units', {
            method: 'POST',
            body: {
                name
            }
        });
        $('newUnit').value = '';
        await refreshConfig();
        msg('Đã thêm đơn vị ' + name + '.');
    } catch (e) {
        msg(e.message, 'error');
    }
}
async function initUnits() {
    state.units = await api('/api/units');
    $('scoreUnit').innerHTML = state.units.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
}
function setupEvents() {
    document.querySelectorAll('.nav-item').forEach(x => x.addEventListener('click', () => setView(x.dataset.view)));
    document.querySelectorAll('[data-go]').forEach(x => x.addEventListener('click', () => setView(x.dataset.go)));
    $('globalWeek').addEventListener('change', () => refresh().catch(e => msg(e.message, 'error')));
    $('refreshBtn').addEventListener('click', () => refresh().then( () => msg('Dữ liệu đã được cập nhật.')).catch(e => msg(e.message, 'error')));
    $('entryForm').addEventListener('submit', submitEntry);
    document.querySelectorAll('input[name="scoreMode"]').forEach(x => x.addEventListener('change', toggleScoreMode));
    $('clearEntry').addEventListener('click', clearEntry);
    $('deleteScore').addEventListener('click', async () => {
        const day = $('scoreDay').value
          , uid = $('scoreUnit').value;
        if (!confirm(`Xóa điểm của đơn vị đã chọn vào ngày ${formatDay(day)}?`))
            return;
        try {
            await api('/api/scores?day=' + day + '&unit_id=' + uid, {
                method: 'DELETE'
            });
            await refresh();
            clearEntry();
            msg('Đã xóa điểm ngày.');
        } catch (e) {
            msg(e.message, 'error');
        }
    }
    );
    document.querySelectorAll('#analysisTabs button').forEach(x => x.addEventListener('click', () => {
        state.analysisPeriod = x.dataset.period;
        updateAnalysis().catch(e => msg(e.message, 'error'));
    }
    ));
    $('selectedMonth').addEventListener('change', () => updateAnalysis().catch(e => msg(e.message, 'error')));
    $('addPositive').addEventListener('click', () => addCustomKeyword('positive'));
    $('addNegative').addEventListener('click', () => addCustomKeyword('negative'));
    $('customPositive').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addCustomKeyword('positive');
        }
    }
    );
    $('customNegative').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addCustomKeyword('negative');
        }
    }
    );
    $('saveRemark').addEventListener('click', () => saveRemarks().catch(e => msg(e.message, 'error')));
    $('draftTemplate').addEventListener('click', () => generate('template'));

    $('draftGemini').addEventListener('click', () => generate('gemini'));
    $('exportWord').addEventListener('click', exportWord);
    $('wordShortcut').addEventListener('click', () => setView('remarks'));
    $('settingsForm').addEventListener('submit', saveSettings);
    $('saveGemini').addEventListener('click', saveGeminiSettings);
    $('testGemini').addEventListener('click', testGeminiSettings);
    $('clearGemini').addEventListener('click', clearGeminiSettings);
    $('backupBtn').addEventListener('click', () => {
        window.location.href = '/api/export/backup';
        msg('Đã yêu cầu tải bản sao lưu.');
    }
    );
    $('dashboardDemoBtn').addEventListener('click', event => loadDemoData(event.currentTarget));
    $('demoBtn').addEventListener('click', event => loadDemoData(event.currentTarget));
    $('addUnit').addEventListener('click', addUnit);
    $('addCriterion').addEventListener('click', addCriterion);
    $('editReportBtn').addEventListener('click', () => setView('settings'));
    $('unitManager').addEventListener('click', e => {
        const b = e.target.closest('[data-save-unit]');
        if (b)
            renameUnitFromUI(Number(b.dataset.saveUnit));
    }
    );
    $('criteriaManager').addEventListener('click', e => {
        const b = e.target.closest('[data-save-criterion],[data-toggle-criterion]');
        if (!b)
            return;
        const code = b.dataset.saveCriterion || b.dataset.toggleCriterion;
        changeCriterionFromUI(code, b.hasAttribute('data-toggle-criterion') ? 'toggle' : 'save');
    }
    );
    $('logoutBtn').addEventListener('click', logout);
    $('changePasswordForm').addEventListener('submit', submitChangePassword);
    $('authForm').addEventListener('submit', submitAuth);
}
async function loadDemoData(button) {
    if (!confirm('Tạo dữ liệu GIẢ LẬP cho 6 tuần đến tuần đang chọn, gồm điểm theo mục tiêu, cộng/trừ và nhận xét? Chỉ thêm vào ngày/đơn vị còn trống; dữ liệu hiện có không bị ghi đè.'))
        return;
    const buttons = [$('dashboardDemoBtn'), $('demoBtn')];
    buttons.forEach(item => item.disabled = true);
    const originalText = button.textContent;
    button.textContent = 'Đang tạo dữ liệu…';
    try {
        const result = await api('/api/demo/load', {
            method: 'POST',
            body: { week_start: state.weekStart }
        });
        $('globalWeek').value = result.week_start;
        await refresh();
        setView('dashboard');
        msg(`Đã tạo ${result.imported} dòng GIẢ LẬP cho ${result.weeks_generated} tuần (${formatDay(result.first_week)} – ${formatDay(addDays(result.week_start, 6))}); ${result.remarks_imported} tuần nhận xét mẫu. ${result.existing} dòng điểm đang có được giữ nguyên.`);
    } catch (e) {
        msg(e.message, 'error');
    } finally {
        button.textContent = originalText;
        buttons.forEach(item => item.disabled = false);
    }
}
function showAuth(firstRun) {
    state.auth = null;
    $('mainApp').hidden = true;
    $('authView').hidden = false;
    window.firstRun = !!firstRun;
    $('authTitle').textContent = firstRun ? 'Thiết lập tài khoản quản trị' : 'Đăng nhập hệ thống';
    $('authSubtitle').textContent = firstRun ? 'Lần đầu sử dụng: hãy đặt tên tài khoản và mật khẩu.' : 'Đăng nhập để xem và chỉnh sửa dữ liệu thi đua.';
    $('authSubmit').textContent = firstRun ? 'Tạo tài khoản và bắt đầu' : 'Đăng nhập';
    $('authUsername').value = firstRun ? 'admin' : ($('authUsername').value || 'admin');
    $('authPassword').value = '';
    $('authConfirm').value = '';
    $('authConfirmGroup').hidden = !firstRun;
    $('authPassword').autocomplete = firstRun ? 'new-password' : 'current-password';
    $('authError').hidden = true;
    $('authNote').textContent = firstRun ? 'Mật khẩu ít nhất 10 ký tự. Hãy lưu ở nơi an toàn theo quy định của đơn vị.' : 'Không cần Internet hoặc mạng LAN. Dữ liệu được lưu trên máy tính này.';
    setTimeout( () => $('authPassword').focus(), 0);
}
async function startAuthorized(data) {
    const [info, units, criteria, gemini] = await Promise.all([
        api('/api/info'),
        api('/api/units'),
        api('/api/criteria'),
        api('/api/gemini/settings')
    ]);
    state.auth = {
        username: data.username,
        csrf: data.csrf
    };
    state.info = info;
    state.units = units;
    state.criteria = criteria;
    state.gemini = gemini;
    state.week = null;
    state.entries = [];
    $('scoreUnit').innerHTML = state.units.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    renderCriteriaInputs();
    try {
        await refresh();
    } catch (error) {
        state.auth = null;
        throw error;
    }
    $('currentUser').textContent = 'Tài khoản: ' + data.username;
    $('authView').hidden = true;
    $('mainApp').hidden = false;
    renderSettings();
    setView('dashboard');
}
async function submitAuth(event) {
    event.preventDefault();
    const firstRun = window.firstRun;
    const username = $('authUsername').value.trim()
      , password = $('authPassword').value;
    $('authError').hidden = true;
    if (firstRun) {
        if (password.length < 10) {
            $('authError').textContent = 'Mật khẩu cần ít nhất 10 ký tự.';
            $('authError').hidden = false;
            return;
        }
        if (password !== $('authConfirm').value) {
            $('authError').textContent = 'Hai mật khẩu không trùng nhau.';
            $('authError').hidden = false;
            return;
        }
    }
    $('authSubmit').disabled = true;
    try {
        let account = getLocalAccount();
        if (firstRun) {
            const saltBytes = crypto?.getRandomValues
                ? crypto.getRandomValues(new Uint8Array(16))
                : Uint8Array.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
            const salt = toBase64(saltBytes);
            account = {
                username,
                salt,
                passwordHash: await hashPassword(password, salt)
            };
            localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(account));
        } else {
            if (!account)
                throw Error('Chưa có tài khoản. Tải lại trang để thiết lập tài khoản mới.');
            if (account.username !== username)
                throw Error('Tên đăng nhập không đúng.');
            const passwordHash = await hashPassword(password, account.salt);
            if (passwordHash !== account.passwordHash)
                throw Error('Mật khẩu không đúng.');
        }
        await startAuthorized({ username: account.username, csrf: '' });
        sessionStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ username: account.username }));
        msg(firstRun ? 'Đã tạo tài khoản quản trị và đăng nhập.' : 'Đã đăng nhập thành công.');
    } catch (e) {
        state.auth = null;
        $('authError').textContent = e.message;
        $('authError').hidden = false;
    } finally {
        $('authSubmit').disabled = false;
    }
}
async function logout() {
    if (!confirm('Đăng xuất khỏi hệ thống thi đua?'))
        return;
    sessionStorage.removeItem(LOCAL_SESSION_KEY);
    state.info = null;
    state.week = null;
    state.entries = [];
    state.remarks = null;
    showAuth(false);
}
async function submitChangePassword(event) {
    event.preventDefault();
    const old_password = $('oldPassword').value
      , new_password = $('newPassword').value;
    if (new_password !== $('newPasswordConfirm').value) {
        msg('Hai mật khẩu mới chưa trùng nhau.', 'error');
        return;
    }
    if (new_password.length < 10) {
        msg('Mật khẩu mới cần ít nhất 10 ký tự.', 'error');
        return;
    }
    const account = getLocalAccount();
    if (!account) {
        msg('Không tìm thấy tài khoản trên máy này.', 'error');
        return;
    }
    const oldHash = await hashPassword(old_password, account.salt);
    if (oldHash !== account.passwordHash) {
        msg('Mật khẩu hiện tại không đúng.', 'error');
        return;
    }
    const newSaltBytes = crypto?.getRandomValues
        ? crypto.getRandomValues(new Uint8Array(16))
        : Uint8Array.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
    account.salt = toBase64(newSaltBytes);
    account.passwordHash = await hashPassword(new_password, account.salt);
    localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(account));
    sessionStorage.removeItem(LOCAL_SESSION_KEY);
    $('changePasswordForm').reset();
    msg('Đổi mật khẩu thành công. Vui lòng đăng nhập lại.');
    showAuth(false);
}
async function init() {
    const now = new Date();
    state.weekStart = monday(localISO(now));
    state.month = localISO(now).slice(0, 7);
    $('globalWeek').value = state.weekStart;
    $('selectedMonth').value = state.month;
    $('todayLabel').textContent = now.toLocaleDateString('vi-VN', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    setupEvents();
    const account = getLocalAccount();
    let session = null;
    try {
        session = JSON.parse(sessionStorage.getItem(LOCAL_SESSION_KEY));
    } catch (_) {
        session = null;
    }
    if (session?.username && account?.username === session.username) {
        try {
            await startAuthorized({ username: session.username, csrf: '' });
        } catch (error) {
            showAuth(false);
            $('authError').textContent = error.message;
            $('authError').hidden = false;
        }
    } else {
        showAuth(!account);
    }
}
document.addEventListener('DOMContentLoaded', init);
