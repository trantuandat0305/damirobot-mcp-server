# DAMI Robot MCP Server

MCP stdio server cho Xiaozhi/imcp.pro để kết nối robot với Moodle API `local_damirobot_api`.

Luồng:

```text
Xiaozhi / imcp.pro
→ damirobot-mcp-server
→ Moodle API /local/damirobot_api/api/tool.php
→ reply_text ngắn
→ Xiaozhi đọc bằng giọng nói
```

## Yêu cầu

- Node.js 18+
- Moodle đã cài `local_damirobot_api` bản v1.0.8 trở lên
- API token của `local_damirobot_api`

## Biến môi trường

Không đưa token vào GitHub. Khi chạy local, copy `.env.example` thành `.env`. Khi chạy trên imcp.pro, nhập trong Environment Variables / Secrets.

```env
MOODLE_BASE_URL=https://elearning.anhngumsmy.com
MOODLE_API_TOKEN=PASTE_MOODLE_API_TOKEN_HERE
MOODLE_TOOL_ENDPOINT=/local/damirobot_api/api/tool.php
DEFAULT_COURSEID=4
DEFAULT_USERID=
DEFAULT_GROUPID=
VOICE=1
REQUEST_TIMEOUT_MS=15000
LOG_LEVEL=info
```

## Test local trên Windows

Mở CMD trong thư mục này:

```cmd
npm install
npm start
```

Server sẽ chạy qua STDIO, nên bình thường sẽ không hiện giao diện chat. Để test dễ hơn, dùng mock tester trước. Server này chủ yếu để imcp/Xiaozhi gọi.

Kiểm tra cú pháp:

```cmd
npm run check
```

## Cấu hình trên imcp.pro

### Cách A: From Git Repository

1. Upload toàn bộ thư mục này lên GitHub, ví dụ:

```text
https://github.com/yourname/damirobot-mcp-server
```

2. Trong imcp.pro → Add MCP Server → From Git Repository:

```text
Git Repository URL: https://github.com/yourname/damirobot-mcp-server
Category: Other hoặc Education nếu có
Add to public: không tick
```

3. Sau khi tạo, nếu có mục Environment Variables, thêm:

```env
MOODLE_BASE_URL=https://elearning.anhngumsmy.com
MOODLE_API_TOKEN=TOKEN_THẬT_CỦA_BẠN
DEFAULT_COURSEID=4
VOICE=1
```

### Cách B: Manual STDIO + npx

Nếu imcp.pro cho cấu hình thủ công:

```text
Mode: STDIO
Command: npx
Arguments:
  -y
  github:yourname/damirobot-mcp-server
```

Environment Variables như trên.

## Tool có sẵn

- `test_connection`
- `find_student`
- `get_student_summary`
- `get_student_attendance`
- `get_missing_homework`
- `get_student_suspend_status`
- `get_student_dami_status`
- `get_student_latest_scores`
- `get_student_goal_status`
- `get_course_risk_students`

## Ghi chú an toàn

- Server này chỉ gọi API read-only của Moodle.
- Không chứa token trong code.
- Không sửa/xóa/đình chỉ/check-in/feed DAMI.
- Token phải đặt trong Environment Variables.


## v0.1.1

- Added MCP tool `get_student_fulltest_history`.
- This tool is for questions about recent FULL TEST/LR history, several latest tests, score trend, and whether scores are improving or dropping.
- No tokens are stored in code; keep Moodle token in environment variables only.


## Emotion metadata

Moodle API v1.0.11+ may return `emotion` and `emotion_label`. This MCP server forwards it as `Emotion: ...` metadata and instructs the AI to use it as speaking style only, not to read the emotion label aloud.


## Xiaozhi emotion compatibility

This server expects Moodle API `emotion` values to use Xiaozhi official emotion names such as `neutral`, `happy`, `thinking`, `sad`, `confused`, and `confident`. If a tool fails before Moodle returns metadata, the server uses `sad` for the error fallback.


## v0.1.5
- Metadata/user-agent version aligned with package version.
- No tool/schema change from v0.1.3.


## 0.1.5

- Pin `@modelcontextprotocol/sdk` to `1.29.0` instead of `latest` for more stable imcp/npx installs.
- No schema/tool behavior changes.
