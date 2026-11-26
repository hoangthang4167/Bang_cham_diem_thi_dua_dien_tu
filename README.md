# Bảng chấm điểm thi đua điện tử

Ứng dụng chấm điểm chạy cục bộ bằng Node.js. Chatbot hỏi đáp PDF là dịch vụ tùy chọn riêng, dùng LangGraph, Supabase và Gemini (Google).

## Chạy ứng dụng

1. Cài Node.js 20 trở lên.
2. Mở PowerShell tại thư mục dự án.
3. Chạy `npm start`.
4. Mở `http://127.0.0.1:4173` trong trình duyệt. Không mở `index.html` trực tiếp bằng `file://`.

Đổi cổng bằng biến môi trường `PORT` (mặc định `4173`). Dịch vụ chỉ bind vào `127.0.0.1`, không mở cổng cho máy khác trong mạng.

## Chatbot hỏi đáp tài liệu PDF

Mã nguồn của [ai-pdf-chatbot-langchain](https://github.com/mayooear/ai-pdf-chatbot-langchain) được clone vào `pdf-chatbot/` và giữ nguyên giấy phép MIT. Repo upstream ghi rõ hiện không còn được duy trì. Dịch vụ PDF chạy riêng với ứng dụng chấm điểm. Sau khi đăng nhập, bấm **biểu tượng chat tròn ở góc phải dưới màn hình** (hoặc mục **Hỏi đáp tài liệu PDF** ở thanh điều hướng) để mở khung chat thu nhỏ ngay trong ứng dụng; trong khung có nút phóng to, tải lại và mở tab mới. Biểu tượng có chấm trạng thái (xanh: đủ dịch vụ, vàng: thiếu backend, đỏ: chưa chạy) và khung tự hướng dẫn khởi động khi dịch vụ chưa chạy. Cổng mặc định nằm ở đầu tệp `chat-widget.js` (`CONFIG`).

### Ứng dụng Electron cho máy tính

Sau khi cài dependencies và cấu hình các tệp `.env` theo hướng dẫn bên dưới, chạy `npm run desktop` để mở cửa sổ chatbot. Electron tự khởi động LangGraph ở cổng `2024`, Next.js ở cổng `3000`, đợi cả hai dịch vụ sẵn sàng rồi mới mở giao diện; khi đóng cửa sổ, các tiến trình con cũng được dừng.

Tạo bộ cài Windows `.exe` bằng `npm run desktop:build`. File cài đặt nằm trong `dist/`; bộ cài chứa mã nguồn và dependencies cần thiết để chạy, không yêu cầu cài Node.js trên máy người dùng. Các khóa API không được đưa vào bộ cài. Lần mở đầu tiên, ứng dụng tạo `backend.env` và `frontend.env` trong thư mục cấu hình người dùng rồi hiển thị vị trí tệp; điền `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` trong `backend.env`, sau đó mở lại ứng dụng.

### Cấu hình lần đầu

1. Tạo một dự án Supabase và một khóa Gemini API tại [Google AI Studio](https://aistudio.google.com/apikey) (một khóa dùng cho cả trả lời và embedding).
2. Trong terminal tại thư mục dự án (cần có mạng), chạy lần lượt hai lệnh:

   ```powershell
   npm run pdf:install
   npm run pdf:use-gemini
   ```

   Lệnh thứ hai chuyển chatbot gốc (vốn dùng OpenAI) sang Gemini, xem mục "Dùng Gemini thay OpenAI" bên dưới.
3. Tạo file môi trường cục bộ bằng PowerShell:

   ```powershell
   if (-not (Test-Path pdf-chatbot\backend\.env)) { Copy-Item pdf-chatbot\backend\.env.example pdf-chatbot\backend\.env }
   if (-not (Test-Path pdf-chatbot\frontend\.env)) { Copy-Item pdf-chatbot\frontend\.env.example pdf-chatbot\frontend\.env }
   ```

4. Điền `GEMINI_API_KEY` (khóa Gemini), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` trong `pdf-chatbot\backend\.env`. Không đưa các khóa này vào Git hoặc chia sẻ qua chat. Đổi `LANGCHAIN_TRACING_V2=true` thành `false` trong cả hai tệp `.env` (mẫu `.env.example` bật sẵn tính năng gửi nhật ký hội thoại tới LangSmith trên Internet).

   **Bắt buộc** với `pdf-chatbot\frontend\.env`: dòng `LANGCHAIN_API_KEY=` phải có giá trị (không để trống), ví dụ `LANGCHAIN_API_KEY=local-dev`. Mã frontend gốc từ chối chạy khi biến này rỗng (lỗi `LANGCHAIN_API_KEY is not set`, mọi thao tác tải PDF và chat đều trả lỗi 500). Máy chủ LangGraph chạy cục bộ không kiểm tra giá trị này.
5. Tạo bảng `documents`, hàm `match_documents` và bật vector extension trong Supabase: mở **SQL Editor** của project Supabase, dán nội dung tệp [`supabase/setup.sql`](supabase/setup.sql) rồi chạy (tệp theo [hướng dẫn SupabaseVectorStore của LangChain](https://js.langchain.com/docs/integrations/vectorstores/supabase/), có bật thêm RLS để chỉ khóa `SERVICE_ROLE` truy cập được). Nếu trước đó đã chạy bản SQL cũ dành cho OpenAI, làm theo ghi chú ở đầu tệp để xóa bảng cũ trước (vector của OpenAI và Gemini không dùng chung được nên phải tải lại PDF).
6. Mở ba terminal tại thư mục dự án và chạy lần lượt:

   ```powershell
   npm start
   npm run pdf:backend
   npm run pdf:frontend
   ```

7. Mở ứng dụng chính tại `http://127.0.0.1:4173`, đăng nhập rồi bấm biểu tượng chat ở góc phải dưới. Chatbot cũng mở được trực tiếp tại `http://localhost:3000`; tải PDF (tối đa 5 tệp, mỗi tệp dưới 10 MB), chờ nạp xong rồi đặt câu hỏi.

### Dùng Gemini thay OpenAI

Mã chatbot gốc dùng OpenAI. Lệnh `npm run pdf:use-gemini` (tệp `scripts/use-gemini.js`, chạy sau `npm run pdf:install`) đổi sang Gemini bằng cách:

- cài gói `@langchain/google-genai` (dòng 0.1.x, khớp với `@langchain/core` 0.3.40 mà `yarn.lock` của chatbot đang khóa) vào `pdf-chatbot/backend` và cập nhật `yarn.lock`, nên cần có mạng;
- sửa `backend/src/shared/retrieval.ts` (embedding `gemini-embedding-001`), `backend/src/retrieval_graph/configuration.ts` và `frontend/constants/graphConfigs.ts` (mô hình trả lời `gemini-3.8-flash`), cùng tệp mẫu `.env.example`;
- thêm dòng `GEMINI_API_KEY=` để trống vào `backend/.env` nếu tệp này đã có.

Script chạy lại nhiều lần vẫn an toàn và có thể xem trước bằng `npm run pdf:use-gemini -- --dry-run`. Nếu mã trong `pdf-chatbot` đã bị sửa khác bản gốc, script dừng lại, không ghi gì và liệt kê chỗ không khớp; khi đó hãy sửa tay các chỗ trên rồi chạy lại. Cài lại hoặc clone mới `pdf-chatbot` thì cũng chạy lại lệnh này.

Đổi tên mô hình: mô hình trả lời nằm ở `queryModel` trong `frontend/constants/graphConfigs.ts` (dạng `google-genai/<tên mô hình>`, frontend gửi giá trị này trong mỗi yêu cầu nên nó được ưu tiên hơn mặc định ở backend); mô hình embedding đặt bằng biến `GEMINI_EMBEDDING_MODEL` trong `backend/.env`. Đổi mô hình embedding thì phải xóa dữ liệu cũ và tải lại PDF.

### Xử lý sự cố chatbot PDF

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
| --- | --- | --- |
| Biểu tượng chat có chấm đỏ, khung báo "chưa chạy" | Chưa khởi động dịch vụ | Chạy `npm run pdf:backend` và `npm run pdf:frontend` ở hai cửa sổ PowerShell riêng; khung tự nhận ra sau tối đa 5 giây |
| Chấm vàng, ô nhập câu hỏi bị khóa | Backend (cổng 2024) chưa chạy | Chạy `npm run pdf:backend`; khung sẽ tự tải lại khi backend sẵn sàng |
| Tải PDF hoặc gửi câu hỏi báo lỗi 500, terminal frontend ghi `LANGCHAIN_API_KEY is not set` | `LANGCHAIN_API_KEY` trong `pdf-chatbot\frontend\.env` bị để trống | Điền một giá trị bất kỳ (ví dụ `local-dev`), khởi động lại `npm run pdf:frontend` |
| Nạp PDF xong nhưng lỗi `Could not find the table 'public.documents'` hoặc `match_documents` | Chưa chạy SQL khởi tạo Supabase | Chạy `supabase/setup.sql` trong SQL Editor |
| Chat hoặc tải PDF báo `42501 permission denied for table documents` | Khóa server chưa có quyền trên bảng hoặc sequence Supabase | Chạy lại `supabase/setup.sql` trong SQL Editor (script không xóa tài liệu), kiểm tra `SUPABASE_SERVICE_ROLE_KEY` thuộc đúng project Supabase rồi khởi động lại backend |
| Lỗi `API key not valid`, 400, 403 hoặc 429 khi hỏi hoặc tải PDF | Sai khóa `GEMINI_API_KEY`, khóa chưa dùng được Gemini API, hoặc vượt hạn mức miễn phí (429) | Kiểm tra khóa tại [AI Studio](https://aistudio.google.com/apikey), đợi hết hạn mức hoặc bật thanh toán, rồi khởi động lại backend |
| Lỗi `Cannot find package '@langchain/google-genai'` hoặc `Please set an API key for Google GenerativeAI` | Chưa chạy `npm run pdf:use-gemini` hoặc chưa điền `GEMINI_API_KEY` | Chạy lệnh đó, điền khóa vào `pdf-chatbot\backend\.env`, khởi động lại backend |
| Lỗi `expected 1536 dimensions, not 3072` hoặc `different vector dimensions` | Bảng `documents` còn là bản cũ dành cho OpenAI | Xóa bảng cũ theo ghi chú ở đầu `supabase/setup.sql`, chạy lại tệp và tải lại PDF |
| Khung chat trắng nhưng mở được ở tab mới | Trình duyệt chặn nhúng trang | Dùng nút "Mở trong tab mới" trong khung |
| Thư mục `pdf-chatbot` rỗng sau khi tải/clone dự án | Thư mục đang là một repo Git lồng nhau nên GitHub không lưu nội dung | Xem mục "Lưu `pdf-chatbot` vào Git" bên dưới |

### Lưu `pdf-chatbot` vào Git

Nếu `pdf-chatbot` được tạo bằng `git clone` bên trong dự án, Git chỉ ghi một con trỏ tới commit của repo lồng nhau (kiểu "gitlink") mà không lưu mã nguồn, nên bản trên GitHub chỉ có thư mục rỗng. Để lưu mã nguồn thật, chạy trong PowerShell tại thư mục dự án (đã có `.gitignore` chặn `.env` và `node_modules`):

```powershell
git rm --cached pdf-chatbot                    # bỏ con trỏ gitlink (không xóa tệp)
Remove-Item -Recurse -Force pdf-chatbot\.git   # xóa lịch sử Git lồng nhau; mã nguồn vẫn còn nguyên
git add .gitignore pdf-chatbot
git status                                     # PHẢI KIỂM TRA: không được thấy tệp .env hay thư mục node_modules
git commit -m "Đưa mã nguồn pdf-chatbot vào repo"
```

Bước `Remove-Item` làm mất lịch sử commit riêng của `pdf-chatbot` (nội dung đã chỉnh sửa vẫn còn). Chỉ `git push` sau khi `git status` cho thấy không có tệp chứa khóa API.

**Lưu ý dữ liệu:** PDF được trích xuất ở frontend, embeddings do Gemini tạo và lưu trong Supabase; câu hỏi cùng các đoạn tài liệu tìm được được gửi tới Google (Gemini API) để tạo câu trả lời. Theo [Điều khoản bổ sung của Gemini API](https://ai.google.dev/terms) (hiệu lực 23/3/2026), với dịch vụ miễn phí (Unpaid Services) Google có thể dùng nội dung gửi lên để cải thiện sản phẩm, nhân viên đánh giá có thể đọc, và điều khoản yêu cầu không gửi thông tin nhạy cảm, bí mật hoặc cá nhân; với dự án Google Cloud đã bật thanh toán (Paid Services) Google không dùng nội dung để cải thiện sản phẩm. Vì vậy chỉ tải tài liệu đã được phép đưa ra ngoài đơn vị, và nên dùng khóa thuộc dự án có bật thanh toán. Tài liệu/embeddings nằm trong project Supabase đã cấu hình và có thể còn ở đó cho đến khi bạn xóa. Không tải tài liệu nhạy cảm lên nếu chưa được phép. Dự án hiện tại dùng bảng vector chung `documents` như upstream; hãy dành riêng một project/database Supabase cho chatbot này.

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
