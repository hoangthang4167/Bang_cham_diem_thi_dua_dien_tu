import { pathToFileURL } from 'node:url';

// Khi chạy bằng electron.exe với ELECTRON_RUN_AS_NODE=1, process.versions.electron
// vẫn tồn tại nhưng process.defaultApp không được đặt, khiến commander@13+ cắt sai
// process.argv (bỏ qua tên script và coi đường dẫn script là lệnh con).
process.defaultApp = true;

const targetScript = process.argv[2];
if (!targetScript) {
    console.error('Thiếu đường dẫn CLI cần khởi chạy.');
    process.exit(1);
}

process.argv = [process.argv[0], targetScript, ...process.argv.slice(3)];
await import(pathToFileURL(targetScript).href);
