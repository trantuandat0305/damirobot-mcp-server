# DAMI Moodle Robot MCP Server v0.2.0

Zero-dependency MCP STDIO server for Xiaozhi/imcp. This version does **not** use `@modelcontextprotocol/sdk`, so it is lighter and easier for hosted MCP gateways to run from GitHub with `npx`.

## imcp Manual STDIO configuration

Mode: `STDIO`

Command: `npx`

Arguments:

```text
-y
--package
github:trantuandat0305/damirobot-mcp-server
damirobot-mcp-server
```

If the gateway still cannot load schemas, try the shorter argument form:

```text
-y
github:trantuandat0305/damirobot-mcp-server
```

Environment variables:

```env
VOICE=1
MOODLE_BASE_URL=https://elearning.anhngumsmy.com
DEFAULT_COURSEID=4
MOODLE_API_TOKEN=PUT_YOUR_TOKEN_HERE
REQUEST_TIMEOUT_MS=15000
MOODLE_TOOL_ENDPOINT=https://elearning.anhngumsmy.com/local/damirobot_api/api/tool.php
```

## Tools

- `test_connection`
- `find_student`
- `get_student_summary`
- `get_student_attendance`
- `get_missing_homework`
- `get_student_suspend_status`
- `get_student_dami_status`
- `get_student_latest_scores`
- `get_student_goal_status`
- `get_student_fulltest_history`
- `get_course_risk_students`

## Safety

- Read-only: only calls the Moodle DAMI Robot API.
- Does not write, update, delete, suspend, check-in, or feed DAMI.
- No token is stored in code. Put token only in environment variables.
