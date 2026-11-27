'use strict';
/*
 * Biểu tượng chat nổi – Hỏi đáp tài liệu PDF.
 * Nhúng giao diện chatbot PDF (Next.js, cổng 3000) vào khung chat thu nhỏ ở góc phải dưới,
 * thay cho việc mở cửa sổ mới từ thanh điều hướng.
 *
 * Nếu đổi cổng của chatbot, chỉ cần sửa CONFIG bên dưới.
 */
(function () {
    if (document.getElementById('pdfChatWidget')) return;

    const CONFIG = {
        chatUrl: 'http://localhost:3000',          // giao diện chatbot (frontend Next.js)
        backendUrl: 'http://localhost:2024/ok',    // máy chủ LangGraph (backend), dùng để kiểm tra đang chạy
        pingTimeoutMs: 2500,
        retryMs: 5000
    };
    // Bản desktop (Electron): ứng dụng tự quản lý dịch vụ chat và báo trạng thái qua cầu nối này.
    // Trên trình duyệt thường biến này không tồn tại và widget hoạt động như cũ.
    const desktop = window.desktopChat || null;
    const SIZE_KEY = 'pdf_chat_widget_size_v1';
    const CMD_BACKEND = 'npm run pdf:backend';
    const CMD_FRONTEND = 'npm run pdf:frontend';

    const ICONS = {
        chat: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.8-4.9A8.3 8.3 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/><path d="M8.5 11h7M8.5 14h4"/></svg>',
        reload: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
        size: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
        external: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
        minimize: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
    };

    const root = document.createElement('div');
    root.className = 'pcw';
    root.id = 'pdfChatWidget';
    root.dataset.open = 'false';
    root.innerHTML = `
        <section class="pcw-panel" id="pcwPanel" role="dialog" aria-label="Hỏi đáp tài liệu PDF" hidden>
            <header class="pcw-head">
                <div class="pcw-title">
                    <strong>Hỏi đáp tài liệu PDF</strong>
                    <span class="pcw-sub" id="pcwStatus" data-state="unknown"><i></i><span id="pcwStatusText">Chưa kiểm tra</span></span>
                </div>
                <div class="pcw-actions">
                    <button type="button" class="pcw-action" data-act="reload" title="Tải lại khung chat (cuộc hội thoại hiện tại sẽ mất)" aria-label="Tải lại khung chat">${ICONS.reload}</button>
                    <button type="button" class="pcw-action" data-act="size" title="Phóng to / thu nhỏ khung" aria-label="Phóng to hoặc thu nhỏ khung">${ICONS.size}</button>
                    <button type="button" class="pcw-action" data-act="external" title="Mở trong tab mới" aria-label="Mở chatbot trong tab mới">${ICONS.external}</button>
                    <button type="button" class="pcw-action" data-act="close" title="Thu nhỏ (giữ nguyên cuộc hội thoại)" aria-label="Thu nhỏ khung chat">${ICONS.minimize}</button>
                </div>
            </header>
            <div class="pcw-warn" id="pcwWarn" hidden>
                Máy chủ LangGraph (cổng 2024) chưa chạy nên chatbot sẽ báo lỗi khi gửi câu hỏi hoặc tải PDF.
                Hãy chạy <code>${CMD_BACKEND}</code> trong một cửa sổ PowerShell khác.
            </div>
            <div class="pcw-body">
                <iframe class="pcw-frame" id="pcwFrame" title="Chatbot hỏi đáp tài liệu PDF" referrerpolicy="no-referrer" hidden></iframe>
                <div class="pcw-loading" id="pcwLoading">Đang kiểm tra dịch vụ…</div>
                <div class="pcw-offline" id="pcwOffline" hidden>
                    <p class="pcw-offline-title">Dịch vụ chatbot PDF chưa chạy</p>
                    <ul class="pcw-svc">
                        <li><span>Giao diện chat (cổng 3000)</span><b id="pcwSvcFront" data-ok="false">chưa chạy</b></li>
                        <li><span>Máy chủ LangGraph (cổng 2024)</span><b id="pcwSvcBack" data-ok="false">chưa chạy</b></li>
                    </ul>
                    <p>Mở hai cửa sổ PowerShell tại thư mục dự án rồi chạy lần lượt:</p>
                    <div class="pcw-cmd"><code>${CMD_BACKEND}</code><button type="button" class="pcw-btn" data-copy="${CMD_BACKEND}">Chép</button></div>
                    <div class="pcw-cmd"><code>${CMD_FRONTEND}</code><button type="button" class="pcw-btn" data-copy="${CMD_FRONTEND}">Chép</button></div>
                    <p>Lần đầu cần cài đặt và điền khóa theo mục “Chatbot hỏi đáp tài liệu PDF” trong README.md.</p>
                    <div class="pcw-offline-foot">
                        <span>Tự kiểm tra lại sau mỗi ${Math.round(CONFIG.retryMs / 1000)} giây…</span>
                        <button type="button" class="pcw-btn pcw-btn-primary" data-act="recheck">Kiểm tra lại ngay</button>
                    </div>
                </div>
            </div>
        </section>
        <button type="button" class="pcw-fab" id="pcwFab" aria-haspopup="dialog" aria-expanded="false" aria-controls="pcwPanel" aria-label="Mở chatbot hỏi đáp tài liệu PDF">
            ${ICONS.chat}
            <span class="pcw-dot" id="pcwDot" data-state="unknown"></span>
            <span class="pcw-fab-label">Hỏi đáp tài liệu PDF</span>
        </button>`;

    // Gắn vào #mainApp để widget tự ẩn khi chưa đăng nhập; không có thì gắn vào body.
    const app = document.getElementById('mainApp');
    (app || document.body).appendChild(root);

    const $ = id => root.querySelector('#' + id);
    const fab = $('pcwFab');
    const panel = $('pcwPanel');
    const frame = $('pcwFrame');
    const loading = $('pcwLoading');
    const offline = $('pcwOffline');
    const warn = $('pcwWarn');
    const dot = $('pcwDot');
    const status = $('pcwStatus');
    const statusText = $('pcwStatusText');

    const state = { open: false, front: null, back: null, frameBackOk: null, checking: false, retryTimer: 0 };

    if (desktop) {
        offline.innerHTML = `
            <p class="pcw-offline-title" id="pcwDeskTitle">Chatbot đang khởi động…</p>
            <ul class="pcw-svc">
                <li><span>Giao diện chat</span><b id="pcwSvcFront" data-ok="false">đang chờ</b></li>
                <li><span>Máy chủ LangGraph</span><b id="pcwSvcBack" data-ok="false">đang chờ</b></li>
            </ul>
            <p id="pcwDeskMessage"></p>
            <p id="pcwDeskHint"></p>
            <pre class="pcw-log" id="pcwDeskLog" hidden></pre>
            <div class="pcw-offline-foot">
                <button type="button" class="pcw-btn" data-act="config">Mở thư mục cấu hình</button>
                <button type="button" class="pcw-btn pcw-btn-primary" data-act="restart">Thử khởi động lại</button>
            </div>`;
    }

    // Trạng thái do tiến trình chính của bản desktop gửi sang.
    function applyDesktopState(next) {
        if (!next || !next.backend || !next.frontend) return;
        const ready = next.backend.status === 'ready' && next.frontend.status === 'ready';
        const failed = Boolean(next.error);
        CONFIG.chatUrl = next.chatUrl || CONFIG.chatUrl;

        const level = ready ? 'ok' : failed ? 'off' : 'warn';
        dot.dataset.state = level;
        status.dataset.state = level;
        statusText.textContent = ready ? 'Chatbot sẵn sàng' : failed ? 'Chatbot gặp lỗi' : 'Đang khởi động…';

        const labels = { pending: 'đang chờ', starting: 'đang khởi động', checking: 'đang kiểm tra', ready: 'sẵn sàng', error: 'lỗi' };
        for (const [id, service] of [['pcwSvcFront', next.frontend], ['pcwSvcBack', next.backend]]) {
            $(id).dataset.ok = String(service.status === 'ready');
            $(id).textContent = labels[service.status] || service.status;
        }
        $('pcwDeskTitle').textContent = failed ? 'Chatbot chưa hoạt động được' : 'Chatbot đang khởi động…';
        $('pcwDeskMessage').textContent = failed ? next.error.split('\n')[0] : (next.overallMessage || '');
        $('pcwDeskHint').textContent = failed ? (next.configHint || '') : 'Bạn vẫn chấm điểm bình thường trong lúc chờ.';
        $('pcwDeskLog').hidden = !(failed && next.logs);
        $('pcwDeskLog').textContent = failed ? (next.logs || '') : '';
        offline.querySelector('[data-act="restart"]').hidden = !failed;

        // Chỉ nạp khung khi cả hai dịch vụ sẵn sàng; dịch vụ dừng thì bỏ khung cũ để lần sau nạp mới.
        if (!ready && !frameIsEmpty()) frame.src = 'about:blank';
        loading.hidden = true;
        offline.hidden = ready;
        frame.hidden = !ready;
        if (ready && state.open && frameIsEmpty()) {
            loading.hidden = false;
            loading.textContent = 'Đang mở chatbot…';
            frame.src = CONFIG.chatUrl;
        }
    }

    function refreshDesktop() {
        desktop.getState().then(applyDesktopState).catch(() => {});
    }

    function readSize() {
        try {
            return localStorage.getItem(SIZE_KEY) === 'large';
        } catch (_) {
            return false;
        }
    }
    function saveSize(large) {
        try {
            localStorage.setItem(SIZE_KEY, large ? 'large' : 'compact');
        } catch (_) { /* trình duyệt chặn lưu trữ: bỏ qua */ }
    }
    panel.classList.toggle('pcw-large', readSize());

    // Kiểm tra cổng có đang lắng nghe không. mode "no-cors": máy chủ chạy thì trả về phản hồi
    // "opaque" (không đọc được nội dung nhưng không báo lỗi); máy chủ tắt thì fetch báo lỗi mạng.
    async function ping(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIG.pingTimeoutMs);
        try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
            return true;
        } catch (_) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    function frameIsEmpty() {
        const src = frame.getAttribute('src');
        return !src || src === 'about:blank';
    }

    function render() {
        if (desktop) return;
        let level = 'unknown';
        let text = 'Chưa kiểm tra';
        if (state.front === true && state.back === true) {
            level = 'ok';
            text = 'Dịch vụ đang chạy';
        } else if (state.front === true) {
            level = 'warn';
            text = 'Thiếu máy chủ LangGraph';
        } else if (state.front === false) {
            level = 'off';
            text = 'Dịch vụ chưa chạy';
        }
        dot.dataset.state = level;
        status.dataset.state = level;
        statusText.textContent = text;
        if (!state.open || state.front === null) return;

        loading.hidden = true;
        warn.hidden = !(state.front && state.back === false);
        if (state.front) {
            offline.hidden = true;
            if (frameIsEmpty()) {
                loading.hidden = false;
                loading.textContent = 'Đang mở chatbot…';
                state.frameBackOk = state.back;
                frame.src = CONFIG.chatUrl;
            } else if (state.back === true && state.frameBackOk === false) {
                // Trang chatbot tạo luồng hội thoại ngay khi tải và khóa ô nhập nếu backend chưa chạy.
                // Backend vừa lên sau khi khung đã mở thì tải lại để ô nhập hoạt động.
                loading.hidden = false;
                loading.textContent = 'Máy chủ đã sẵn sàng, đang tải lại chatbot…';
                state.frameBackOk = true;
                frame.src = CONFIG.chatUrl;
            }
            frame.hidden = false;
        } else {
            frame.hidden = true;
            offline.hidden = false;
            const front = $('pcwSvcFront');
            const back = $('pcwSvcBack');
            front.dataset.ok = String(state.front);
            front.textContent = state.front ? 'đang chạy' : 'chưa chạy';
            back.dataset.ok = String(state.back);
            back.textContent = state.back ? 'đang chạy' : 'chưa chạy';
        }
    }

    function clearRetry() {
        clearTimeout(state.retryTimer);
        state.retryTimer = 0;
    }

    async function check() {
        if (desktop) {
            refreshDesktop();
            return;
        }
        if (state.checking) return;
        state.checking = true;
        clearRetry();
        if (state.front === null) {
            loading.hidden = false;
            loading.textContent = 'Đang kiểm tra dịch vụ…';
        }
        const [front, back] = await Promise.all([ping(CONFIG.chatUrl), ping(CONFIG.backendUrl)]);
        state.checking = false;
        state.front = front;
        state.back = back;
        render();
        // Còn thiếu dịch vụ và khung đang mở thì tự kiểm tra lại, người dùng không cần bấm.
        if (state.open && (!front || !back)) {
            state.retryTimer = setTimeout(check, CONFIG.retryMs);
        }
    }

    function open() {
        if (state.open) return;
        state.open = true;
        root.dataset.open = 'true';
        fab.setAttribute('aria-expanded', 'true');
        fab.setAttribute('aria-label', 'Thu nhỏ khung chat');
        panel.hidden = false;
        if (state.front === null) loading.hidden = false;
        render();
        check();
    }

    function close(returnFocus) {
        if (!state.open) return;
        state.open = false;
        root.dataset.open = 'false';
        fab.setAttribute('aria-expanded', 'false');
        fab.setAttribute('aria-label', 'Mở chatbot hỏi đáp tài liệu PDF');
        panel.hidden = true;
        clearRetry();
        if (returnFocus) fab.focus();
    }

    // Đăng xuất: đóng khung và xóa nội dung chat để người dùng sau không thấy hội thoại cũ.
    function resetAll() {
        close(false);
        frame.src = 'about:blank';
        frame.hidden = true;
        state.front = null;
        state.back = null;
        state.frameBackOk = null;
        render();
        if (desktop) {
            desktop.closeChatWindow();
            refreshDesktop();
        }
    }

    fab.addEventListener('click', () => (state.open ? close(false) : open()));

    root.addEventListener('click', event => {
        const copyBtn = event.target.closest('[data-copy]');
        if (copyBtn) {
            const original = copyBtn.textContent;
            const done = ok => {
                copyBtn.textContent = ok ? 'Đã chép' : 'Bôi đen để chép';
                setTimeout(() => (copyBtn.textContent = original), 1600);
            };
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(copyBtn.dataset.copy).then(() => done(true), () => done(false));
            } else {
                done(false);
            }
            return;
        }
        const actionBtn = event.target.closest('[data-act]');
        if (!actionBtn) return;
        switch (actionBtn.dataset.act) {
            case 'close':
                close(true);
                break;
            case 'external':
                window.open(CONFIG.chatUrl, '_blank', 'noopener,noreferrer');
                break;
            case 'size': {
                const large = panel.classList.toggle('pcw-large');
                saveSize(large);
                break;
            }
            case 'reload':
                frame.src = 'about:blank';
                loading.hidden = false;
                loading.textContent = 'Đang tải lại…';
                state.front = null;
                check();
                break;
            case 'recheck':
                check();
                break;
            case 'restart':
                desktop?.retryStartup();
                break;
            case 'config':
                desktop?.openConfigDir();
                break;
        }
    });

    frame.addEventListener('load', () => {
        if (!frameIsEmpty()) loading.hidden = true;
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.open) close(true);
    });

    // Mục "Hỏi đáp tài liệu PDF" trên thanh điều hướng: nhấp thường mở khung chat nhanh;
    // Ctrl/Shift/nhấp giữa vẫn mở tab mới như trước.
    const navLink = document.querySelector('[data-pdf-chat]');
    if (navLink) {
        navLink.title = 'Mở khung chat nhanh (giữ Ctrl khi nhấp để mở tab mới)';
        navLink.addEventListener('click', event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            open();
        });
    }

    if (desktop) {
        if (navLink) navLink.title = 'Mở khung chat nhanh';
        const external = root.querySelector('[data-act="external"]');
        external.title = 'Mở trong cửa sổ riêng';
        external.setAttribute('aria-label', 'Mở chatbot trong cửa sổ riêng');
        desktop.onStateChange(applyDesktopState);
        refreshDesktop();
    }

    if (app && typeof MutationObserver === 'function') {
        new MutationObserver(() => {
            if (app.hidden) resetAll();
        }).observe(app, { attributes: true, attributeFilter: ['hidden'] });
    }
})();
