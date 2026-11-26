-- Khởi tạo kho vector cho chatbot hỏi đáp PDF (chạy MỘT LẦN trong Supabase → SQL Editor).
-- Khớp với mã nguồn chatbot: bảng "documents" và hàm "match_documents".
-- Embedding do Gemini tạo (mặc định gemini-embedding-001, 3072 chiều). Cột vector được khai báo
-- KHÔNG cố định số chiều, nên đổi mô hình embedding sau này không cần sửa tệp này.

-- ---------------------------------------------------------------------------------------------
-- NẾU TRƯỚC ĐÓ ĐÃ CHẠY BẢN CŨ DÀNH CHO OPENAI (cột vector 1536 chiều):
-- bỏ dấu "--" ở hai dòng dưới để xóa bảng cũ. Vector của OpenAI và Gemini không dùng chung được,
-- nên TOÀN BỘ tài liệu đã nạp sẽ mất và phải tải lại PDF. Đổi mô hình embedding sau này cũng vậy.
-- drop function if exists match_documents(vector, int, jsonb);
-- drop table if exists documents;
-- ---------------------------------------------------------------------------------------------

-- 1. Bật phần mở rộng pgvector (kiểu dữ liệu vector).
create extension if not exists vector;

-- 2. Bảng lưu các đoạn tài liệu và vector tương ứng.
create table if not exists documents (
  id bigserial primary key,
  content text,    -- nội dung đoạn văn (Document.pageContent)
  metadata jsonb,  -- thông tin kèm theo, ví dụ tên tệp (Document.metadata)
  embedding vector -- số chiều tùy mô hình embedding (Gemini: 3072)
);

-- Chỉ cấp quyền truy cập trực tiếp cho khóa máy chủ; RLS vẫn bật và không có policy cho client.
grant usage on schema public to service_role;
revoke all on table public.documents from anon, authenticated;
grant select, insert, update, delete on table public.documents to service_role;
revoke all on sequence public.documents_id_seq from public, anon, authenticated;
grant usage, select on sequence public.documents_id_seq to service_role;

-- 3. Hàm tìm các đoạn gần nghĩa nhất với câu hỏi.
create or replace function match_documents (
  query_embedding vector,
  match_count int default null,
  filter jsonb default '{}'
) returns table (
  id bigint,
  content text,
  metadata jsonb,
  embedding jsonb,
  similarity float
)
language plpgsql
as $$
#variable_conflict use_column
begin
  return query
  select
    id,
    content,
    metadata,
    (embedding::text)::jsonb as embedding,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where metadata @> filter
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

revoke all on function public.match_documents(vector, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.match_documents(vector, int, jsonb)
  to service_role;

-- Lưu ý: cột không khai báo số chiều thì không tạo được chỉ mục (index) tăng tốc. Với một kho
-- tài liệu nhỏ của một đơn vị (vài nghìn đoạn) việc quét tuần tự vẫn nhanh. Nếu sau này cần chỉ mục,
-- hãy chuyển sang cột có số chiều cố định (pgvector chỉ lập chỉ mục tới 2000 chiều).

-- 4. Khuyến nghị bảo mật: bảng tạo bằng SQL Editor mặc định KHÔNG bật RLS (Row Level Security -
--    bảo vệ theo từng dòng), tức là ai có "anon key" của project đều đọc/ghi được tài liệu.
--    Bật RLS và không tạo policy nào: chỉ SUPABASE_SERVICE_ROLE_KEY (khóa của chatbot) truy cập được.
alter table documents enable row level security;
