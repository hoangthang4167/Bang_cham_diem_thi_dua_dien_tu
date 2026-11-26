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
const startupTimeoutMs = 120000;
const maxLogLines = 80;

let mainWindow = null;
let backendProcess = null;
let frontendProcess = null;
let isQuitting = false;
let chatLoaded = false;
let activeStartupToken = 0;
let stopPromise = null;

const statusState = {
    overallMessage: 'Đang chuẩn bị khởi động...',
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
    const currentUrl = mainWindow.webContents.getURL();
    if (currentUrl.startsWith('file://')) {
        mainWindow.webContents.send('status:update', statusState);
    }
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

function ensurePackagedConfigFiles() {
    if (!app.isPackaged) return;

    const configDirectory = app.getPath('userData');
    fs.mkdirSync(configDirectory, { recursive: true });

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

    if (serviceName === 'backend') {
        const required = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
        const missing = required.filter(key => !values[key] || values[key].startsWith('your-'));

        if (missing.length > 0) {
            throw new Error(
                `Hãy điền ${missing.join(', ')} trong tệp cấu hình ${envPath}.`
            );
        }
    }

    if (serviceName === 'frontend') {
        if (!values.LANGCHAIN_API_KEY) {
            throw new Error(`Hãy điền LANGCHAIN_API_KEY trong tệp cấu hình ${envPath}.`);
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
        if (isQuitting || !chatLoaded) return;
        const activeChild = serviceKey === 'backend' ? backendProcess : frontendProcess;
        if (activeChild !== child) return;

        chatLoaded = false;
        updateServiceStatus(serviceKey, 'error', `Dịch vụ đã dừng bất ngờ (mã ${code ?? signal ?? 'không rõ'})`);
        updateStatus({
            overallMessage: `${serviceName} đã dừng đột ngột.`,
            error: `${serviceName} đã dừng trong khi đang sử dụng.`,
            configHint: 'Bấm "Thử khởi động lại" để bật lại dịch vụ.',
            logs: logBuffer.slice(-25).join('\n')
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadFile(statusPagePath);
        }
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

async function waitForService(url, child, serviceName, serviceKey, logBuffer, token, timeout = startupTimeoutMs) {
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

        if (await httpGetOk(url)) {
            return;
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
    chatLoaded = false;

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
            token
        );
        updateServiceStatus('frontend', 'ready', `Đang hoạt động tại 127.0.0.1:${frontendPort}`);
        updateStatus({ overallMessage: 'Tất cả dịch vụ đã sẵn sàng. Đang mở giao diện chat...' });

        if (isQuitting || token !== activeStartupToken) return;

        chatLoaded = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
            await mainWindow.loadURL(frontendUrl);
        }
    } catch (error) {
        if (isQuitting || token !== activeStartupToken) return;

        console.error('Lỗi khởi động chatbot:', error);
        await stopServices();

        if (statusState.backend.status !== 'ready') {
            updateServiceStatus('backend', 'error', 'Khởi động thất bại');
        }
        if (statusState.frontend.status !== 'ready' && statusState.frontend.status !== 'pending') {
            updateServiceStatus('frontend', 'error', 'Khởi động thất bại');
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
    chatLoaded = false;
    await stopServices();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.getURL().startsWith('file://')) {
        await mainWindow.loadFile(statusPagePath);
    }
    await startChatbot(token);
}

function buildAppMenu() {
    const template = [
        {
            label: 'Tệp',
            submenu: [
                {
                    label: 'Khởi động lại dịch vụ Chatbot',
                    click: () => { restartChatbot(); }
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
                { type: 'separator' },
                { label: 'Công cụ nhà phát triển', role: 'toggleDevTools' }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
    const windowOptions = {
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 680,
        title: 'Chatbot hỏi đáp PDF',
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

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.loadFile(statusPagePath);
}

function assertStatusCaller(event) {
    const senderUrl = event.senderFrame?.url || '';
    if (!senderUrl.startsWith('file://')) {
        throw new Error('Không có quyền truy cập kênh điều khiển nội bộ.');
    }
}

ipcMain.handle('status:get-state', event => {
    assertStatusCaller(event);
    return statusState;
});

ipcMain.handle('status:retry', event => {
    assertStatusCaller(event);
    restartChatbot();
});

ipcMain.handle('status:open-config-dir', event => {
    assertStatusCaller(event);
    return shell.openPath(getConfigDirectory());
});

ipcMain.handle('status:quit', event => {
    assertStatusCaller(event);
    app.quit();
});

app.whenReady().then(() => {
    if (isQuitting) return;

    buildAppMenu();
    createWindow();
    const token = ++activeStartupToken;
    startChatbot(token).catch(error => {
        console.error('Lỗi không mong đợi khi khởi động:', error);
        dialog.showErrorBox('Lỗi khởi động Chatbot PDF', error.message);
    });
});

app.on('before-quit', event => {
    if (isQuitting) return;

    event.preventDefault();
    isQuitting = true;
    activeStartupToken++;
    stopServices().finally(() => app.quit());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (!mainWindow && !isQuitting) {
        createWindow();
        if (chatLoaded) {
            mainWindow.loadURL(frontendUrl);
        }
    }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (!isQuitting) app.quit();
    });
}
