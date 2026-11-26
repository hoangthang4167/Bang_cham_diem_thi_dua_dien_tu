#!/usr/bin/env node
'use strict';
/*
 * Chuyển chatbot PDF (thư mục pdf-chatbot/) từ OpenAI sang Gemini.
 *
 * Chạy tại thư mục dự án:  npm run pdf:use-gemini
 *
 * Tùy chọn:
 *   --dir <thư mục>   thư mục chatbot (mặc định: pdf-chatbot)
 *   --dry-run         chỉ báo sẽ sửa gì, không ghi gì
 *   --no-install      không cài gói @langchain/google-genai (tự chạy lệnh được in ra sau đó)
 *
 * Script chạy lại nhiều lần vẫn an toàn: tệp nào đã đổi thì bỏ qua. Nếu một tệp không còn
 * giống mã gốc (ví dụ bạn đã tự sửa), script dừng lại và KHÔNG ghi bất cứ tệp nào.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHAT_MODEL = 'google-genai/gemini-3.8-flash';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const PACKAGE = '@langchain/google-genai';
// Dòng 0.1.x tương thích với @langchain/core 0.3.40 mà yarn.lock của chatbot đang khóa.
// Dòng 1.x/2.x của gói yêu cầu @langchain/core 1.x nên không dùng được ở đây.
const PACKAGE_RANGE = '~0.1.7';
const YARN = 'corepack yarn@1.22.22';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);

if (has('--help') || has('-h')) {
    console.log('Cách dùng: npm run pdf:use-gemini [-- --dir <thư mục>] [--dry-run] [--no-install]');
    process.exit(0);
}

const dirIndex = args.indexOf('--dir');
const root = path.resolve(dirIndex >= 0 && args[dirIndex + 1] ? args[dirIndex + 1] : 'pdf-chatbot');
const dryRun = has('--dry-run');
const skipInstall = has('--no-install');

const CHAT_MODEL_PATTERN = /(['"])openai\/[\w.\-]+\1/;

// Mỗi mục: tệp cần sửa, dấu hiệu "còn dùng OpenAI" (pending) và các thay thế.
const TARGETS = [
    {
        file: 'backend/src/shared/retrieval.ts',
        pending: /OpenAIEmbeddings|@langchain\/openai/,
        edits: [
            {
                what: 'dòng import OpenAIEmbeddings từ @langchain/openai',
                find: /import\s*\{\s*OpenAIEmbeddings\s*\}\s*from\s*(['"])@langchain\/openai\1\s*;?/,
                to: "import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';"
            },
            {
                what: 'đoạn khởi tạo new OpenAIEmbeddings({ ... })',
                find: /new\s+OpenAIEmbeddings\(\s*\{[\s\S]*?\}\s*\)/,
                to: `new GoogleGenerativeAIEmbeddings({\n    model: process.env.GEMINI_EMBEDDING_MODEL || '${EMBEDDING_MODEL}',\n  })`
            }
        ]
    },
    {
        file: 'backend/src/retrieval_graph/configuration.ts',
        pending: CHAT_MODEL_PATTERN,
        edits: [{
            what: "mô hình mặc định dạng 'openai/...'",
            find: CHAT_MODEL_PATTERN,
            to: `'${CHAT_MODEL}'`
        }]
    },
    {
        // Frontend gửi queryModel trong mỗi yêu cầu nên giá trị này mới là giá trị thực sự được dùng.
        file: 'frontend/constants/graphConfigs.ts',
        pending: CHAT_MODEL_PATTERN,
        edits: [{
            what: "queryModel dạng 'openai/...'",
            find: CHAT_MODEL_PATTERN,
            to: `'${CHAT_MODEL}'`
        }]
    },
    {
        file: 'backend/.env.example',
        optional: true,
        pending: /^OPENAI_API_KEY=/m,
        edits: [{
            what: 'dòng OPENAI_API_KEY=',
            find: /^OPENAI_API_KEY=.*$/m,
            to: '# Khóa Gemini API, tạo tại https://aistudio.google.com/apikey\nGOOGLE_API_KEY='
        }]
    }
];

function planFiles() {
    const changes = [];
    const notes = [];
    const errors = [];
    for (const target of TARGETS) {
        const abs = path.join(root, target.file);
        if (!fs.existsSync(abs)) {
            (target.optional ? notes : errors).push(`${target.file}: không tìm thấy tệp`);
            continue;
        }
        const raw = fs.readFileSync(abs, 'utf8');
        const crlf = raw.includes('\r\n');
        let text = raw.replace(/\r\n/g, '\n');
        if (!target.pending.test(text)) {
            notes.push(`${target.file}: đã ở dạng Gemini, bỏ qua`);
            continue;
        }
        let failed = false;
        for (const edit of target.edits) {
            if (!edit.find.test(text)) {
                errors.push(`${target.file}: không tìm thấy ${edit.what}`);
                failed = true;
                break;
            }
            text = text.replace(edit.find, () => edit.to);
        }
        if (failed) continue;
        if (target.pending.test(text)) {
            errors.push(`${target.file}: sau khi sửa vẫn còn chỗ dùng OpenAI`);
            continue;
        }
        changes.push({ file: target.file, abs, content: crlf ? text.replace(/\n/g, '\r\n') : text });
    }
    return { changes, notes, errors };
}

// Thêm dòng GOOGLE_API_KEY= (để trống) vào backend/.env nếu chưa có. Không đọc hay in giá trị nào trong tệp.
function planEnv() {
    const abs = path.join(root, 'backend', '.env');
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    if (/^\s*GOOGLE_API_KEY\s*=/m.test(raw)) return { abs, append: null };
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lead = raw.length > 0 && !raw.endsWith('\n') ? eol : '';
    return { abs, append: `${lead}# Khóa Gemini API, tạo tại https://aistudio.google.com/apikey${eol}GOOGLE_API_KEY=${eol}` };
}

function needsInstall() {
    const file = path.join(root, 'backend', 'package.json');
    if (!fs.existsSync(file)) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !(pkg.dependencies && pkg.dependencies[PACKAGE]);
}

function fail(code, lines) {
    console.error(lines.join('\n'));
    process.exit(code);
}

const installCommand = `${YARN} add "${PACKAGE}@${PACKAGE_RANGE}"`;

if (!fs.existsSync(path.join(root, 'backend', 'package.json'))) {
    fail(1, [
        `Không tìm thấy thư mục chatbot tại: ${root}`,
        'Hãy chạy lệnh tại thư mục dự án (nơi có thư mục pdf-chatbot) hoặc thêm --dir <đường dẫn>.'
    ]);
}

const { changes, notes, errors } = planFiles();
if (errors.length) {
    fail(1, [
        'Dừng lại, CHƯA ghi tệp nào, vì mã trong pdf-chatbot không còn giống bản gốc:',
        ...errors.map(line => `  - ${line}`),
        '',
        'Bạn có thể tự sửa tay theo hướng dẫn trong README (mục "Dùng Gemini thay OpenAI"),',
        'rồi chạy lại script này để cài gói còn thiếu.'
    ]);
}

const env = planEnv();
const install = needsInstall() && !skipInstall;

console.log(dryRun ? 'Chế độ chạy thử (--dry-run), không ghi gì:' : 'Chuyển chatbot PDF sang Gemini:');
for (const change of changes) console.log(`  sửa  ${change.file}`);
for (const note of notes) console.log(`  --   ${note}`);
if (env) console.log(env.append ? '  sửa  backend/.env (thêm dòng GOOGLE_API_KEY= để trống)' : '  --   backend/.env: đã có GOOGLE_API_KEY');
if (needsInstall()) console.log(skipInstall ? `  --   bỏ qua cài gói (--no-install). Tự chạy trong pdf-chatbot/backend: ${installCommand}` : `  cài  ${PACKAGE}@${PACKAGE_RANGE}`);
else console.log(`  --   ${PACKAGE} đã có trong backend/package.json`);

if (dryRun) process.exit(0);

// Cài gói TRƯỚC khi ghi mã: nếu cài lỗi (mất mạng...) thì mã vẫn nguyên như cũ, không bị import gói chưa có.
if (install) {
    console.log(`\nĐang chạy: ${installCommand}  (trong ${path.join(root, 'backend')})`);
    const result = spawnSync(installCommand, { cwd: path.join(root, 'backend'), stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        fail(2, [
            '',
            'Cài gói không thành công nên CHƯA sửa tệp nào. Kiểm tra kết nối mạng rồi chạy lại: npm run pdf:use-gemini'
        ]);
    }
}

for (const change of changes) fs.writeFileSync(change.abs, change.content);
if (env && env.append) fs.appendFileSync(env.abs, env.append);

console.log('\nXong. Các bước tiếp theo:');
console.log('  1. Mở pdf-chatbot\\backend\\.env, dán khóa Gemini vào dòng GOOGLE_API_KEY= (tạo tại https://aistudio.google.com/apikey).');
console.log('     Dòng OPENAI_API_KEY không còn dùng nữa, có thể xóa.');
console.log('  2. Supabase: chạy supabase/setup.sql trong SQL Editor (nếu trước đó đã tạo bảng cho OpenAI, làm theo ghi chú ở đầu tệp để xóa bảng cũ).');
console.log('  3. Dừng và chạy lại: npm run pdf:backend  và  npm run pdf:frontend, rồi tải lại các tệp PDF.');
