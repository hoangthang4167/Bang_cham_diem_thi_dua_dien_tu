'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const electronBinary = require('electron');

const env = { ...process.env };
// Bỏ ELECTRON_RUN_AS_NODE nếu đang chạy từ terminal tích hợp của IDE (VS Code / Antigravity),
// tránh việc electron.exe khởi động ở chế độ Node thuần thay vì ứng dụng Electron GUI.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
    windowsHide: false
});

child.on('close', (code, signal) => {
    if (code === null) {
        console.error(`Electron đã dừng với tín hiệu ${signal}`);
        process.exit(1);
    }
    process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (child.exitCode === null) child.kill(signal);
    });
}
