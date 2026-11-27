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

// Các tệp .env.example được đóng vào bộ cài, nên không được chứa khóa thật. Không in giá trị khóa.
const secretLine = /^[ \t]*(GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|LANGCHAIN_API_KEY|LANGSMITH_API_KEY)[ \t]*=[ \t]*(.*)$/gm;
const leaked = [];
for (const file of ['backend/.env.example', 'frontend/.env.example']) {
    for (const [, name, raw] of fs.readFileSync(path.join(root, file), 'utf8').matchAll(secretLine)) {
        const value = raw.trim().replace(/^["']|["']$/g, '');
        if (value && !value.startsWith('your-') && value !== 'local-dev') leaked.push(`${file}: ${name}`);
    }
}

if (leaked.length > 0) {
    console.error('Dừng build: tệp mẫu đang có giá trị khóa, sẽ bị đưa vào bộ cài:');
    for (const item of leaked) console.error(`  - pdf-chatbot/${item}`);
    console.error('Hãy xóa giá trị (để trống sau dấu =) trong các tệp trên rồi build lại.');
    process.exit(1);
}

// Tùy chọn cho bản nội bộ: desktop-config/backend.env được đóng vào bộ cài. Không in giá trị khóa.
const bundledConfig = path.resolve(__dirname, '..', 'desktop-config', 'backend.env');

if (fs.existsSync(bundledConfig)) {
    const text = fs.readFileSync(bundledConfig, 'utf8');
    const empty = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(name => {
        const match = text.match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`, 'm'));
        const value = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
        return !value || value.startsWith('your-');
    });
    if (empty.length > 0) {
        console.error(`Dừng build: desktop-config/backend.env còn thiếu ${empty.join(', ')}.`);
        process.exit(1);
    }
    console.warn('CẢNH BÁO: bộ cài sẽ CHỨA KHÓA trong desktop-config/backend.env. Ai có bộ cài đều đọc được khóa.');
} else {
    console.log('Không có desktop-config/backend.env: người dùng sẽ tự cấu hình khóa trên từng máy.');
}

console.log('Đủ thành phần để build bộ cài desktop.');
