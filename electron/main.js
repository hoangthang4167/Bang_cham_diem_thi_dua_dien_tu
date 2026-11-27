'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const chatbotRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'pdf-chatbot')
    : path.resolve(__dirname, '..', 'pdf-chatbot');
const backendRoot = path.join(chatbotRoot, 'backend');
const frontendRoot = path.join(chatbotRoot, 'frontend');
const cliRunnerPath = path.join(__dirname, 'cli-runner.mjs');
const statusPagePath = path.join(__dirname, 'status.html');
const appIconPath = path.resolve(__dirname, '..', 'logo_f9.png');

const backendPort = 2024;
const frontendPort = 3000;
const backendHealthUrl = `http://127.0.0.1:${backendPort}/info`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
// Bảng chấm điểm (server.js) chạy ngay trong tiến trình chính; server.js đọc cùng biến PORT.
const appPort = Number(process.env.PORT || 4173);
const appUrl = `http://127.0.0.1:${appPort}`;
const productTitle = 'Bảng chấm điểm thi đua điện tử';
const startupTimeoutMs = 120000;
const maxLogLines = 80;

let mainWindow = null;
let chatWindow = null;
let appServer = null;
let backendProcess = null;
let frontendProcess = null;
let isQuitting = false;
let chatReady = false;
let activeStartupToken = 0;
let stopPromise = null;

const statusState = {
    overallMessage: 'Đang chuẩn bị khởi động...',
    chatUrl: frontendUrl,
    app: { status: 'pending', detail: `Cổng ${appPort} — Bảng chấm điểm` },
    backend: { status: 'pending', detail: `Cổng ${backendPort} — LangGraph` },
    frontend: { status: 'pending', detail: `Cổng ${frontendPort} — Giao diện Chat` },
    error: null,
    configHint: '',
    logs: ''
};

if (!app.requestSingleInstanceLock()) {
    isQuitting = true;
    app.quit();
}

app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
});

function broadcastStatus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Cả trang trạng thái lẫn khung chat trong ứng dụng đều nhận trạng thái.
    mainWindow.webContents.send('status:update', statusState);
}

function updateStatus(patch) {
    Object.assign(statusState, patch);
    broadcastStatus();
}

function updateServiceStatus(serviceKey, status, detail) {
    statusState[serviceKey] = { status, detail };
    broadcastStatus();
}

function getConfigDirectory() {
    return app.isPackaged ? app.getPath('userData') : chatbotRoot;
}

const requiredBackendKeys = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function getMissingBackendKeys(values) {
    return requiredBackendKeys.filter(key => !values[key] || values[key].startsWith('your-'));
}

// Bộ cài phát hành nội bộ có thể kèm sẵn cấu hình (desktop-config/backend.env lúc build).
// Chỉ chép khi máy chưa có cấu hình đủ khóa, không ghi đè cấu hình người dùng đã điền.
function applyBundledBackendConfig(configPath) {
    const bundledPath = path.join(process.resourcesPath, 'default-config', 'backend.env');
    if (!fs.existsSync(bundledPath)) return;

    if (fs.existsSync(configPath)) {
        const dotenv = require(path.join(chatbotRoot, 'node_modules', 'dotenv'));
        const current = dotenv.parse(fs.readFileSync(configPath));
        if (getMissingBackendKeys(current).length === 0) return;
    }

    fs.copyFileSync(bundledPath, configPath);
}

function ensurePackagedConfigFiles() {
    if (!app.isPackaged) return;

    const configDirectory = app.getPath('userData');
    fs.mkdirSync(configDirectory, { recursive: true });

    applyBundledBackendConfig(path.join(configDirectory, 'backend.env'));

    const configFiles = [
        ['backend', backendRoot],
        ['frontend', frontendRoot]
    ];

    for (const [name, serviceRoot] of configFiles) {
        const configPath = path.join(configDirectory, `${name}.env`);
        const examplePath = path.join(serviceRoot, '.env.example');

        if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
            fs.copyFileSync(examplePath, configPath);
        }
    }

    // @langchain/langgraph-cli đọc langgraph.json ("env": ".env") trực tiếp từ backendRoot.
    // Trong bản đóng gói .env gốc bị loại khỏi extraResources để tránh lộ khóa API,
    // nên tạo tệp .env rỗng tại backendRoot nếu thư mục cho phép ghi; biến thật vẫn nạp từ userData.
    const packagedBackendDotEnv = path.join(backendRoot, '.env');
    if (!fs.existsSync(packagedBackendDotEnv)) {
        try {
            fs.writeFileSync(packagedBackendDotEnv, '', 'utf8');
        } catch {
            // Bỏ qua nếu thư mục cài đặt chỉ cho phép đọc.
        }
    }
}

function getCliEntry(packageName, binName) {
    const packagePath = path.join(chatbotRoot, 'node_modules', packageName, 'package.json');
    const packageInfo = require(packagePath);
    const bin = typeof packageInfo.bin === 'string'
        ? packageInfo.bin
        : packageInfo.bin?.[binName];

    if (!bin) {
        throw new Error(`Không tìm thấy lệnh ${binName} trong gói ${packageName}.`);
    }

    return path.resolve(path.dirname(packagePath), bin);
}

function getServiceEnvironment(serviceRoot, serviceName) {
    const envPath = app.isPackaged
        ? path.join(app.getPath('userData'), `${serviceName}.env`)
        : path.join(serviceRoot, '.env');

    if (!fs.existsSync(envPath)) {
        throw new Error(`Không tìm thấy tệp cấu hình: ${envPath}`);
    }

    const dotenv = require(path.join(chatbotRoot, 'node_modules', 'dotenv'));
    const values = dotenv.parse(fs.readFileSync(envPath));

    // Không bắt người dùng cuối cấu hình LangSmith: nếu chưa có khóa thật thì tắt tracing
    // để nội dung hội thoại không bị gửi ra ngoài.
    const langsmithKey = values.LANGCHAIN_API_KEY;
    if (!langsmithKey || langsmithKey === 'local-dev' || langsmithKey.startsWith('your-')) {
        values.LANGCHAIN_TRACING_V2 = 'false';
        values.LANGSMITH_TRACING = 'false';
    }

    if (serviceName === 'backend') {
        const missing = getMissingBackendKeys(values);

        if (missing.length > 0) {
            throw new Error(
                `Hãy điền ${missing.join(', ')} trong tệp cấu hình ${envPath}.`
            );
        }
    }

    if (serviceName === 'frontend') {
        // Frontend gốc yêu cầu biến này khác rỗng; LangGraph cục bộ không kiểm tra giá trị.
        if (!values.LANGCHAIN_API_KEY) {
            values.LANGCHAIN_API_KEY = 'local-dev';
        }

        if (!values.NEXT_PUBLIC_LANGGRAPH_API_URL || values.NEXT_PUBLIC_LANGGRAPH_API_URL === `http://localhost:${backendPort}`) {
            values.NEXT_PUBLIC_LANGGRAPH_API_URL = `http://127.0.0.1:${backendPort}`;
        }
    }

    return { ...process.env, ...values };
}

async function ensurePortIsAvailable(port, serviceName) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();

        probe.once('error', error => {
            if (error.code === 'EADDRINUSE') {
                reject(new Error(
                    `Cổng ${port} đang được sử dụng; hãy đóng dịch vụ khác đang chạy rồi mở lại ứng dụng.`
                ));
                return;
            }

            reject(error);
        });

        probe.listen(port, '127.0.0.1', () => {
            probe.close(error => error ? reject(error) : resolve());
        });
    }).catch(error => {
        throw new Error(`${serviceName}: ${error.message}`);
    });
}

function appendLogLines(buffer, prefix, chunk) {
    const lines = chunk.toString('utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        buffer.push(`[${prefix}] ${line}`);
        if (buffer.length > maxLogLines) {
            buffer.shift();
        }
    }
}

function startNodeService(args, cwd, env, logBuffer, serviceName, serviceKey) {
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    delete childEnv.NODE_OPTIONS;

    const child = spawn(process.execPath, args, {
        cwd,
        env: childEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout?.on('data', chunk => appendLogLines(logBuffer, serviceName, chunk));
    child.stderr?.on('data', chunk => appendLogLines(logBuffer, `${serviceName}:err`, chunk));

    child.on('error', error => {
        child.startupError = error;
    });

    child.on('exit', (code, signal) => {
        if (isQuitting || !chatReady) return;
        const activeChild = serviceKey === 'backend' ? backendProcess : frontendProcess;
        if (activeChild !== child) return;

        chatReady = false;
        updateServiceStatus(serviceKey, 'error', `Dịch vụ đã dừng bất ngờ (mã ${code ?? signal ?? 'không rõ'})`);
        updateStatus({
            overallMessage: `${serviceName} đã dừng đột ngột.`,
            error: `${serviceName} đã dừng trong khi đang sử dụng.`,
            configHint: 'Bấm "Thử khởi động lại" để bật lại dịch vụ.',
            logs: logBuffer.slice(-25).join('\n')
        });
    });

    return child;
}

function httpGetOk(url, timeoutMs = 15000) {
    return new Promise(resolve => {
        const request = http.get(url, { timeout: timeoutMs }, response => {
            response.resume();
            resolve(response.statusCode >= 200 && response.statusCode < 400);
        });

        request.on('error', () => resolve(false));
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
    });
}

async function waitForService(url, child, serviceName, serviceKey, logBuffer, token, dependencies = [], timeout = startupTimeoutMs) {
    const startedAt = Date.now();
    updateServiceStatus(serviceKey, 'checking', `Đang kiểm tra HTTP (${url})`);

    while (Date.now() - startedAt < timeout) {
        if (isQuitting || token !== activeStartupToken) {
            throw new Error('Quá trình khởi động đã bị hủy.');
        }

        if (child.startupError) {
            throw new Error(`${serviceName}: ${child.startupError.message}`);
        }

        if (child.exitCode !== null || child.signalCode !== null) {
            const tail = logBuffer.slice(-10).join('\n');
            throw new Error(
                `${serviceName} đã dừng trong quá trình khởi động.` +
                (tail ? `\n${tail}` : '')
            );
        }

        // Dịch vụ đã sẵn sàng trước đó mà dừng giữa chừng thì cũng coi là khởi động thất bại.
        for (const dependency of dependencies) {
            if (dependency.child.exitCode !== null || dependency.child.signalCode !== null) {
                updateServiceStatus(dependency.key, 'error', 'Dịch vụ đã dừng bất ngờ');
                throw new Error(
                    `${dependency.name} đã dừng trong khi chờ ${serviceName}.\n` +
                    logBuffer.slice(-10).join('\n')
                );
            }
        }

        if (await httpGetOk(url)) {
            // Kiểm tra lại: dịch vụ phụ thuộc có thể dừng trong lúc đang chờ phản hồi HTTP.
            if (dependencies.every(d => d.child.exitCode === null && d.child.signalCode === null)) {
                return;
            }
            continue;
        }

        await new Promise(resolve => setTimeout(resolve, 800));
    }

    throw new Error(`${serviceName} không phản hồi sau ${Math.round(timeout / 1000)} giây.`);
}

function stopProcess(child) {
    if (!child || child.pid == null || child.exitCode !== null) {
        return Promise.resolve();
    }

    if (process.platform === 'win32') {
        return new Promise(resolve => {
            execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], error => {
                if (error && child.exitCode === null) {
                    console.error(`Không dừng được tiến trình ${child.pid}:`, error.message);
                }
                resolve();
            });
        });
    }

    return new Promise(resolve => {
        const forceTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
        }, 4000);

        child.once('close', () => {
            clearTimeout(forceTimer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

function stopServices() {
    if (stopPromise) return stopPromise;

    const processes = [frontendProcess, backendProcess];
    frontendProcess = null;
    backendProcess = null;
    chatReady = false;

    stopPromise = Promise.all(processes.map(stopProcess)).finally(() => {
        stopPromise = null;
    });
    return stopPromise;
}

async function startChatbot(token) {
    const logBuffer = [];

    try {
        updateStatus({
            overallMessage: 'Đang kiểm tra cấu hình và cổng kết nối...',
            error: null,
            configHint: '',
            logs: ''
        });
        updateServiceStatus('backend', 'pending', `Kiểm tra cấu hình & cổng ${backendPort}`);
        updateServiceStatus('frontend', 'pending', `Chờ Backend cổng ${backendPort} sẵn sàng`);

        ensurePackagedConfigFiles();
        const backendEnv = getServiceEnvironment(backendRoot, 'backend');
        const frontendEnv = getServiceEnvironment(frontendRoot, 'frontend');

        await ensurePortIsAvailable(backendPort, 'Backend chatbot');
        await ensurePortIsAvailable(frontendPort, 'Frontend chatbot');

        if (isQuitting || token !== activeStartupToken) return;

        updateStatus({ overallMessage: 'Đang khởi động Backend LangGraph (cổng 2024)...' });
        updateServiceStatus('backend', 'starting', `Đang chạy tiến trình LangGraph trên cổng ${backendPort}`);

        backendProcess = startNodeService(
            [
                cliRunnerPath,
                getCliEntry('@langchain/langgraph-cli', 'langgraphjs'),
                'dev',
                '--host',
                '127.0.0.1',
                '--port',
                String(backendPort),
                '--no-browser'
            ],
            backendRoot,
            backendEnv,
            logBuffer,
            'Backend',
            'backend'
        );

        await waitForService(
            backendHealthUrl,
            backendProcess,
            'Backend chatbot',
            'backend',
            logBuffer,
            token
        );
        updateServiceStatus('backend', 'ready', `Đang hoạt động tại 127.0.0.1:${backendPort}`);

        if (isQuitting || token !== activeStartupToken) return;

        updateStatus({ overallMessage: 'Đang khởi động Frontend giao diện Chat (cổng 3000)...' });
        updateServiceStatus('frontend', 'starting', `Đang chạy Next.js trên cổng ${frontendPort}`);

        frontendProcess = startNodeService(
            [
                getCliEntry('next', 'next'),
                'dev',
                '--hostname',
                '127.0.0.1',
                '--port',
                String(frontendPort)
            ],
            frontendRoot,
            frontendEnv,
            logBuffer,
            'Frontend',
            'frontend'
        );

        await waitForService(
            frontendUrl,
            frontendProcess,
            'Frontend chatbot',
            'frontend',
            logBuffer,
            token,
            [{ child: backendProcess, name: 'Backend chatbot', key: 'backend' }]
        );
        updateServiceStatus('frontend', 'ready', `Đang hoạt động tại 127.0.0.1:${frontendPort}`);
        updateStatus({ overallMessage: 'Dịch vụ chat đã sẵn sàng.' });

        if (isQuitting || token !== activeStartupToken) return;

        chatReady = true;
        updateStatus({ overallMessage: 'Chatbot PDF đã sẵn sàng.' });
    } catch (error) {
        if (isQuitting || token !== activeStartupToken) return;

        console.error('Lỗi khởi động chatbot:', error);
        await stopServices();
        // Trong lúc chờ dừng, người dùng có thể đã bấm khởi động lại.
        if (isQuitting || token !== activeStartupToken) return;

        for (const key of ['backend', 'frontend']) {
            const { status } = statusState[key];
            if (status === 'ready') {
                updateServiceStatus(key, 'pending', 'Đã dừng');
            } else if (key === 'backend' || status !== 'pending') {
                updateServiceStatus(key, 'error', 'Khởi động thất bại');
            }
        }

        const configHint = app.isPackaged
            ? `Cấu hình được lưu tại ${app.getPath('userData')}. Hãy kiểm tra backend.env và frontend.env rồi bấm "Thử khởi động lại".`
            : 'Kiểm tra các tệp .env trong pdf-chatbot/backend và pdf-chatbot/frontend.';

        updateStatus({
            overallMessage: 'Không thể khởi động Chatbot PDF.',
            error: error.message,
            configHint,
            logs: logBuffer.slice(-30).join('\n')
        });
    }
}

async function restartChatbot() {
    const token = ++activeStartupToken;
    chatReady = false;
    updateStatus({ overallMessage: 'Đang khởi động lại Chatbot...', error: null, configHint: '', logs: '' });
    updateServiceStatus('backend', 'pending', 'Đang dừng dịch vụ cũ');
    updateServiceStatus('frontend', 'pending', 'Đang dừng dịch vụ cũ');
    await stopServices();
    if (isQuitting || token !== activeStartupToken) return;
    await startChatbot(token);
}

async function startScoringApp() {
    updateServiceStatus('app', 'starting', `Đang mở bảng chấm điểm trên cổng ${appPort}`);
    try {
        const { startServer } = require('../server');
        appServer = await startServer();
    } catch (error) {
        const message = error.code === 'EADDRINUSE'
            ? `Cổng ${appPort} đang được sử dụng. Hãy đóng cửa sổ đang chạy "npm start" (hoặc phần mềm khác dùng cổng này) rồi thử lại.`
            : error.message;
        console.error('Lỗi mở bảng chấm điểm:', error);
        updateServiceStatus('app', 'error', 'Khởi động thất bại');
        updateStatus({ overallMessage: 'Không thể mở bảng chấm điểm.', error: message, configHint: '' });
        return false;
    }
    updateServiceStatus('app', 'ready', `Đang hoạt động tại 127.0.0.1:${appPort}`);
    return true;
}

function stopScoringApp() {
    const server = appServer;
    appServer = null;
    if (!server) return Promise.resolve();
    // Chờ yêu cầu đang xử lý (ví dụ đang lưu điểm) hoàn tất, tối đa 3 giây.
    return new Promise(resolve => {
        const timer = setTimeout(resolve, 3000);
        server.close(() => {
            clearTimeout(timer);
            resolve();
        });
        server.closeIdleConnections();
    });
}

// Mở giao diện chính trước, sau đó khởi động chatbot ở nền: thiếu khóa hay mất mạng
// không làm gián đoạn việc chấm điểm.
let bootPromise = null;

function boot() {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
        updateStatus({ overallMessage: 'Đang mở bảng chấm điểm...', error: null, configHint: '' });
        if (!appServer && !(await startScoringApp())) return;
        if (isQuitting) return;
        if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(appUrl);
        restartChatbot().catch(reportUnexpectedError);
    })().finally(() => {
        bootPromise = null;
    });
    return bootPromise;
}

function reportUnexpectedError(error) {
    if (isQuitting) return;
    console.error('Lỗi không mong đợi:', error);
    dialog.showErrorBox('Lỗi khởi động ứng dụng', error.message);
}

function buildAppMenu() {
    const template = [
        {
            label: 'Tệp',
            submenu: [
                {
                    label: 'Khởi động lại dịch vụ Chatbot',
                    click: () => { retryStartup(); }
                },
                {
                    label: 'Mở thư mục cấu hình (.env)',
                    click: () => { shell.openPath(getConfigDirectory()); }
                },
                { type: 'separator' },
                {
                    label: 'Thoát',
                    accelerator: 'Alt+F4',
                    click: () => { app.quit(); }
                }
            ]
        },
        {
            label: 'Sửa',
            submenu: [
                { label: 'Hoàn tác', role: 'undo' },
                { label: 'Làm lại', role: 'redo' },
                { type: 'separator' },
                { label: 'Cắt', role: 'cut' },
                { label: 'Sao chép', role: 'copy' },
                { label: 'Dán', role: 'paste' },
                { label: 'Chọn tất cả', role: 'selectAll' }
            ]
        },
        {
            label: 'Xem',
            submenu: [
                {
                    label: 'Tải lại trang hiện tại',
                    accelerator: 'Ctrl+R',
                    click: () => {
                        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
                    }
                },
                { type: 'separator' },
                { label: 'Phóng to', role: 'zoomIn' },
                { label: 'Thu nhỏ', role: 'zoomOut' },
                { label: 'Kích thước mặc định', role: 'resetZoom' },
                // Bản cài đặt không mở công cụ nhà phát triển (có thể dùng để bỏ qua đăng nhập).
                ...(app.isPackaged ? [] : [
                    { type: 'separator' },
                    { label: 'Công cụ nhà phát triển', role: 'toggleDevTools' }
                ])
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openChatWindow() {
    if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.focus();
        return;
    }
    // Cửa sổ chat riêng không có preload, tức không gọi được lệnh điều khiển ứng dụng.
    chatWindow = new BrowserWindow({
        width: 1000,
        height: 760,
        title: 'Hỏi đáp tài liệu PDF',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    chatWindow.on('closed', () => {
        chatWindow = null;
    });
    chatWindow.webContents.setWindowOpenHandler(handleWindowOpen);
    chatWindow.loadURL(frontendUrl);
}

function closeChatWindow() {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
}

function getOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

function handleWindowOpen({ url }) {
    const origin = getOrigin(url);
    if (origin === frontendUrl || origin === `http://localhost:${frontendPort}`) {
        openChatWindow();
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
    }
    return { action: 'deny' };
}

function createWindow() {
    const windowOptions = {
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 680,
        title: productTitle,
        backgroundColor: '#f3f6fb',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    };

    if (fs.existsSync(appIconPath)) {
        windowOptions.icon = appIconPath;
    }

    mainWindow = new BrowserWindow(windowOptions);

    mainWindow.webContents.setWindowOpenHandler(handleWindowOpen);

    // Cửa sổ chính (có preload) chỉ được ở lại trong ứng dụng.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (getOrigin(url) !== appUrl) event.preventDefault();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        closeChatWindow();
    });

    mainWindow.loadFile(statusPagePath);
}

function retryStartup() {
    const task = appServer ? restartChatbot() : boot();
    task.catch(reportUnexpectedError);
}

// Chỉ trang trạng thái nội bộ và giao diện chính được gọi lệnh điều khiển.
function assertAppCaller(event) {
    const senderUrl = event.senderFrame?.url || '';
    if (!senderUrl.startsWith('file://') && getOrigin(senderUrl) !== appUrl) {
        throw new Error('Không có quyền truy cập kênh điều khiển nội bộ.');
    }
}

ipcMain.handle('status:get-state', event => {
    assertAppCaller(event);
    return statusState;
});

ipcMain.handle('status:retry', event => {
    assertAppCaller(event);
    retryStartup();
});

ipcMain.handle('status:open-config-dir', event => {
    assertAppCaller(event);
    return shell.openPath(getConfigDirectory());
});

ipcMain.handle('status:close-chat-window', event => {
    assertAppCaller(event);
    closeChatWindow();
});

ipcMain.handle('status:quit', event => {
    assertAppCaller(event);
    app.quit();
});

app.whenReady().then(() => {
    if (isQuitting) return;

    buildAppMenu();
    createWindow();
    boot().catch(reportUnexpectedError);
});

app.on('before-quit', event => {
    if (isQuitting) return;

    event.preventDefault();
    isQuitting = true;
    activeStartupToken++;
    Promise.all([stopServices(), stopScoringApp()]).finally(() => app.quit());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (!mainWindow && !isQuitting) {
        createWindow();
        if (appServer) mainWindow.loadURL(appUrl);
    }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (!isQuitting) app.quit();
    });
}
