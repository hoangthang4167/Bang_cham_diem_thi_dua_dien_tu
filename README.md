# Bảng chấm điểm thi đua điện tử

Ứng dụng chấm điểm chạy cục bộ bằng Node.js. Chatbot hỏi đáp PDF là dịch vụ tùy chọn riêng, dùng LangGraph, Supabase và OpenAI.

## Chạy ứng dụng

1. Cài Node.js 20 trở lên.
2. Mở PowerShell tại thư mục dự án.
3. Chạy `npm start`.
4. Mở `http://127.0.0.1:4173` trong trình duyệt. Không mở `index.html` trực tiếp bằng `file://`.

Đổi cổng bằng biến môi trường `PORT` (mặc định `4173`). Dịch vụ chỉ bind vào `127.0.0.1`, không mở cổng cho máy khác trong mạng.

## Chatbot hỏi đáp tài liệu PDF

Mã nguồn của [ai-pdf-chatbot-langchain](https://github.com/mayooear/ai-pdf-chatbot-langchain) được clone vào `pdf-chatbot/` và giữ nguyên giấy phép MIT. Repo upstream ghi rõ hiện không còn được duy trì. Dịch vụ PDF chạy riêng với ứng dụng chấm điểm; chọn **Hỏi đáp tài liệu PDF** ở thanh điều hướng để mở giao diện khi các dịch vụ đã khởi động.

### Cấu hình lần đầu

1. Tạo một dự án Supabase và chuẩn bị API key OpenAI có quyền dùng chat completions và embeddings.
2. Trong terminal tại thư mục dự án, chạy `npm run pdf:install`.
3. Tạo file môi trường cục bộ bằng PowerShell:

   ```powershell
   if (-not (Test-Path pdf-chatbot\backend\.env)) { Copy-Item pdf-chatbot\backend\.env.example pdf-chatbot\backend\.env }
   if (-not (Test-Path pdf-chatbot\frontend\.env)) { Copy-Item pdf-chatbot\frontend\.env.example pdf-chatbot\frontend\.env }
   ```

4. Điền `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` trong `pdf-chatbot\backend\.env`. Không đưa các khóa này vào Git hoặc chia sẻ qua chat.
5. Tạo bảng `documents`, hàm `match_documents` và bật vector extension trong Supabase theo [hướng dẫn SupabaseVectorStore của LangChain](https://js.langchain.com/docs/integrations/vectorstores/supabase/).
6. Mở ba terminal tại thư mục dự án và chạy lần lượt:

   ```powershell
   npm start
   npm run pdf:backend
   npm run pdf:frontend
   ```

7. Mở ứng dụng chính tại `http://127.0.0.1:4173`, đăng nhập rồi chọn **Hỏi đáp tài liệu PDF**. Chatbot mở tại `http://127.0.0.1:3000`; tải PDF (tối đa 5 tệp, mỗi tệp dưới 10 MB), chờ nạp xong rồi đặt câu hỏi.

**Lưu ý dữ liệu:** PDF được trích xuất ở frontend, embeddings được tạo bằng OpenAI và lưu trong Supabase; câu hỏi cùng các đoạn tài liệu tìm được được gửi tới OpenAI để tạo câu trả lời. Tài liệu/embeddings nằm trong project Supabase đã cấu hình và có thể còn ở đó cho đến khi bạn xóa. Không tải tài liệu nhạy cảm lên nếu chưa được phép. Dự án hiện tại dùng bảng vector chung `documents` như upstream; hãy dành riêng một project/database Supabase cho chatbot này.

## Dữ liệu và sao lưu

- Dữ liệu được lưu bền vững ở `%LOCALAPPDATA%\BangChamDiemThiDua\data.json` trên Windows.
- Có thể đổi thư mục dữ liệu bằng biến `THI_DUA_DATA_DIR`.
- Dùng **Cài đặt → Tải bản sao lưu dữ liệu** để tải JSON backup. Lưu bản sao lưu vào vị trí được phép sử dụng và bảo vệ.
- **Cài đặt → Tạo dữ liệu giả lập 6 tuần** tạo tối đa 6 tuần dữ liệu tính lùi từ tuần đang chọn: điểm số, điểm cộng/trừ, ghi chú và nhận xét được sinh ngẫu nhiên trong các khoảng/mẫu hợp lý nên mỗi lần tạo có kết quả khác nhau. Dữ liệu giả lập được gắn nhãn rõ ràng. Bản ghi điểm và nhận xét đã có sẽ không bị ghi đè; số dòng thực tế được thông báo sau khi chạy.

## Luồng nghiệp vụ

- Điểm ngày được ghi theo đơn vị và ngày; nhập theo tổng điểm hoặc tổng các mục tiêu đang bật. Ghi lại cùng đơn vị/ngày sẽ cập nhật bản ghi hiện tại.
- Tổng tuần theo quy tắc hiển thị trên ứng dụng: trung bình điểm gốc các ngày đã nhập + tổng điểm cộng − tổng điểm trừ. Tuần đủ khi mọi đơn vị có đủ 7 ngày.
- Điểm tháng là trung bình điểm của các tuần được tính vào tháng theo ngày thứ Năm; tuần đủ dữ liệu được đánh dấu riêng.
- Nhận xét và cấu hình báo cáo được lưu theo tuần/cài đặt; xuất Word tạo tệp `.doc` tương thích Microsoft Word.
- Soạn nhận xét mẫu chạy offline. Gemini Online chỉ được gọi khi người dùng xác nhận; khóa nhập trực tiếp chỉ ở bộ nhớ tiến trình và mất khi tắt dịch vụ. Có thể cấu hình `GEMINI_API_KEY` trong môi trường trước khi chạy.
- Gemini mặc định dùng mô hình `gemini-3.8-flash`; các cấu hình mặc định Gemini Flash cũ sẽ tự chuyển sang mô hình này khi khởi động dịch vụ. Lỗi quá tải tạm thời sẽ được tự thử lại tối đa hai lần; request timeout được thử lại một lần. Nếu vẫn không phản hồi, có thể đợi rồi thử lại hoặc dùng chế độ Offline.

Đây là ứng dụng một người dùng trên máy cục bộ; đăng nhập giao diện hiện là lớp tiện ích phía trình duyệt, không thay thế cơ chế bảo vệ dữ liệu cấp hệ điều hành. Không chia sẻ thư mục dữ liệu hoặc máy đang chạy ứng dụng với người không được phép.
