# Bảng chấm điểm thi đua điện tử

Ứng dụng chạy cục bộ bằng Node.js, không cần npm package bên ngoài.

## Chạy ứng dụng

1. Cài Node.js 20 trở lên.
2. Mở PowerShell tại thư mục dự án.
3. Chạy `npm start`.
4. Mở `http://127.0.0.1:4173` trong trình duyệt. Không mở `index.html` trực tiếp bằng `file://`.

Đổi cổng bằng biến môi trường `PORT` (mặc định `4173`). Dịch vụ chỉ bind vào `127.0.0.1`, không mở cổng cho máy khác trong mạng.

## Dữ liệu và sao lưu

- Dữ liệu được lưu bền vững ở `%LOCALAPPDATA%\BangChamDiemThiDua\data.json` trên Windows.
- Có thể đổi thư mục dữ liệu bằng biến `THI_DUA_DATA_DIR`.
- Dùng **Cài đặt → Tải bản sao lưu dữ liệu** để tải JSON backup. Lưu bản sao lưu vào vị trí được phép sử dụng và bảo vệ.
- **Cài đặt → Tạo dữ liệu giả lập 6 tuần** tạo tối đa 6 tuần dữ liệu tính lùi từ tuần đang chọn: điểm theo mục tiêu, điểm cộng/trừ, ghi chú minh họa và nhận xét mẫu. Dữ liệu giả lập được gắn nhãn rõ ràng. Bản ghi điểm và nhận xét đã có sẽ không bị ghi đè; số dòng thực tế được thông báo sau khi chạy.

## Luồng nghiệp vụ

- Điểm ngày được ghi theo đơn vị và ngày; nhập theo tổng điểm hoặc tổng các mục tiêu đang bật. Ghi lại cùng đơn vị/ngày sẽ cập nhật bản ghi hiện tại.
- Tổng tuần theo quy tắc hiển thị trên ứng dụng: trung bình điểm gốc các ngày đã nhập + tổng điểm cộng − tổng điểm trừ. Tuần đủ khi mọi đơn vị có đủ 7 ngày.
- Điểm tháng là trung bình điểm của các tuần được tính vào tháng theo ngày thứ Năm; tuần đủ dữ liệu được đánh dấu riêng.
- Nhận xét và cấu hình báo cáo được lưu theo tuần/cài đặt; xuất Word tạo tệp `.doc` tương thích Microsoft Word.
- Soạn nhận xét mẫu chạy offline. Gemini Online chỉ được gọi khi người dùng xác nhận; khóa nhập trực tiếp chỉ ở bộ nhớ tiến trình và mất khi tắt dịch vụ. Có thể cấu hình `GEMINI_API_KEY` trong môi trường trước khi chạy.

Đây là ứng dụng một người dùng trên máy cục bộ; đăng nhập giao diện hiện là lớp tiện ích phía trình duyệt, không thay thế cơ chế bảo vệ dữ liệu cấp hệ điều hành. Không chia sẻ thư mục dữ liệu hoặc máy đang chạy ứng dụng với người không được phép.
