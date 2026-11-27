'use strict';

// Chạy tự động trước "npm run desktop:build": dừng sớm nếu bộ cài sẽ thiếu thành phần.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'pdf-chatbot');

// Mỗi mục: danh sách vị trí chấp nhận được (chỉ cần một vị trí tồn tại).
const required = [
    ['backend/package.json'],
    ['backend/langgraph.json'],
    ['backend/.env.example'],
    ['frontend/package.json'],
    ['frontend/.env.example'],
    // electron/main.js nạp ba gói này từ pdf-chatbot/node_modules.
    ['node_modules/next/package.json'],
    ['node_modules/@langchain/langgraph-cli/package.json'],
    ['node_modules/dotenv/package.json'],
    [
        'node_modules/@langchain/google-genai/package.json',
        'backend/node_modules/@langchain/google-genai/package.json'
    ]
];

const missing = required.filter(
    options => !options.some(file => fs.existsSync(path.join(root, file)))
);

if (missing.length > 0) {
    console.error('Chưa thể build bộ cài, còn thiếu trong pdf-chatbot/:');
    for (const options of missing) console.error(`  - ${options.join(' hoặc ')}`);
    console.error('Hãy bảo đảm đã có mã nguồn chatbot, rồi chạy: npm run pdf:install && npm run pdf:use-gemini');
    process.exit(1);
}

console.log('Đủ thành phần để build bộ cài desktop.');
