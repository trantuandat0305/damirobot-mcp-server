#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const CONFIG = {
  moodleBaseUrl: cleanBaseUrl(process.env.MOODLE_BASE_URL || ''),
  moodleToken: process.env.MOODLE_API_TOKEN || '',
  moodleEndpoint: process.env.MOODLE_TOOL_ENDPOINT || '/local/damirobot_api/api/tool.php',
  defaultCourseId: process.env.DEFAULT_COURSEID || '',
  defaultUserId: process.env.DEFAULT_USERID || '',
  defaultGroupId: process.env.DEFAULT_GROUPID || '',
  voice: String(process.env.VOICE || '1') !== '0',
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
  logLevel: process.env.LOG_LEVEL || 'info',
};

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeToolInput(tool, args = {}) {
  const out = { ...args };
  // Guard: if a client accidentally sends a numeric student_name, treat it as userid.
  // This prevents calls like {student_name: "297"} from being searched as a name.
  if (!hasValue(out.userid) && hasValue(out.student_name) && /^\d+$/.test(String(out.student_name).trim())) {
    out.userid = String(out.student_name).trim();
    delete out.student_name;
  }
  return out;
}

function clearStudentContext() {
  context.userid = '';
  context.student_name = '';
}

const context = {
  userid: CONFIG.defaultUserId || '',
  student_name: '',
  courseid: CONFIG.defaultCourseId || '',
  groupid: CONFIG.defaultGroupId || '',
};

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function log(...args) {
  if (CONFIG.logLevel === 'debug') {
    console.error('[damirobot-mcp]', ...args);
  }
}

function ensureConfig() {
  if (!CONFIG.moodleBaseUrl) {
    throw new Error('Missing MOODLE_BASE_URL environment variable.');
  }
  if (!CONFIG.moodleToken) {
    throw new Error('Missing MOODLE_API_TOKEN environment variable.');
  }
}

function textResult(text, isError = false, emotion = '') {
  const cleanText = String(text || '');
  const cleanEmotion = String(emotion || '').trim();
  const output = cleanEmotion
    ? `Emotion: ${cleanEmotion}\nReply: ${cleanText}\nInstruction: Use the emotion as speaking style only; do not read the emotion label aloud.`
    : cleanText;
  return {
    content: [{ type: 'text', text: output }],
    isError,
  };
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
      out[key] = obj[key];
    }
  }
  return out;
}

function withDefaults(tool, args = {}) {
  const merged = normalizeToolInput(tool, args);

  const needsStudent = [
    'get_student_summary',
    'get_student_attendance',
    'get_missing_homework',
    'get_student_suspend_status',
    'get_student_dami_status',
    'get_student_latest_scores',
    'get_student_fulltest_history',
    'get_student_goal_status',
  ].includes(tool);

  const needsCourse = [
    'find_student',
    'get_student_summary',
    'get_student_attendance',
    'get_missing_homework',
    'get_student_suspend_status',
    'get_student_dami_status',
    'get_student_latest_scores',
    'get_student_fulltest_history',
    'get_student_goal_status',
    'get_course_risk_students',
  ].includes(tool);

  if (needsStudent) {
    const explicitUserid = hasValue(merged.userid);
    const explicitStudentName = hasValue(merged.student_name);
    const explicitEmail = hasValue(merged.email);

    // If the client explicitly supplies a new name/email, do NOT inject the old userid.
    // Otherwise Moodle will prioritise the stale userid and answer for the previous student.
    if (!explicitUserid && !explicitStudentName && !explicitEmail) {
      if (context.userid) merged.userid = context.userid;
      else if (context.student_name) merged.student_name = context.student_name;
    }
  }

  if (needsCourse) {
    if (!hasValue(merged.courseid) && context.courseid) merged.courseid = context.courseid;
    if (!hasValue(merged.groupid) && context.groupid) merged.groupid = context.groupid;
  }

  return merged;
}

function updateContextAfterCall(tool, args = {}, data = {}) {
  if (hasValue(args.courseid)) context.courseid = String(args.courseid);
  if (hasValue(args.groupid)) context.groupid = String(args.groupid);

  if (!data || typeof data !== 'object') return;

  // When a lookup is ambiguous/not found, clear the student context so follow-up pronouns
  // do not accidentally keep referring to the previous learner.
  if (data.ok === false && (data.need_clarification || data.error === 'student_ambiguous' || data.error === 'student_not_found')) {
    clearStudentContext();
    return;
  }

  if (data.student && data.student.id) context.userid = String(data.student.id);
  else if (hasValue(args.userid)) context.userid = String(args.userid);

  if (data.student && data.student.name) context.student_name = String(data.student.name);
  else if (hasValue(args.student_name) && !hasValue(args.userid)) context.student_name = String(args.student_name);

  if (data.course && data.course.id) context.courseid = String(data.course.id);
  if (data.group && data.group.id) context.groupid = String(data.group.id);

  // Fallback: parse Vietnamese reply_text like "DAMI đã tìm thấy học viên Đặng Như Biển."
  if (!context.student_name && typeof data.reply_text === 'string') {
    const match = data.reply_text.match(/tìm thấy học viên\s+(.+?)\.?$/i);
    if (match && match[1]) context.student_name = match[1].trim();
  }
}

function buildMoodleUrl() {
  const endpoint = String(CONFIG.moodleEndpoint || '').trim();
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  return `${CONFIG.moodleBaseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
}

async function callMoodle(tool, input = {}) {
  ensureConfig();

  const args = withDefaults(tool, input);

  const voice = tool === 'find_student' ? false : CONFIG.voice;
  const payload = {
    ...args,
    token: CONFIG.moodleToken,
    tool,
    voice: voice ? 1 : 0,
  };

  const url = buildMoodleUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

  try {
    log('calling moodle', tool, pick(payload, ['userid', 'student_name', 'courseid', 'course_name', 'groupid', 'group_name']));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${CONFIG.moodleToken}`,
        'User-Agent': 'damirobot-mcp-server/0.1.9',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (err) {
      throw new Error(`Moodle API returned non-JSON response. HTTP ${res.status}. Body: ${raw.slice(0, 300)}`);
    }

    updateContextAfterCall(tool, args, data);

    const reply = data.reply_text || data.error || `Tool ${tool} finished.`;
    const emotion = data.emotion || '';
    if (!res.ok || data.ok === false) {
      return textResult(reply, true, emotion || 'sad');
    }
    return textResult(reply, false, emotion);
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? 'DAMI chưa kết nối được Moodle vì yêu cầu bị quá thời gian chờ.'
      : `DAMI chưa kết nối được Moodle: ${err?.message || String(err)}`;
    return textResult(message, true, 'sad');
  } finally {
    clearTimeout(timeout);
  }
}

const studentBaseSchema = {
  student_name: { type: 'string', description: 'Tên học viên, có thể là tên đầy đủ hoặc tên thường gọi.' },
  email: { type: 'string', description: 'Email/username học viên nếu cần phân biệt trùng tên.' },
  userid: { type: 'string', description: 'Moodle user ID. Nên dùng khi đã biết để tránh trùng tên.' },
  course_name: { type: 'string', description: 'Tên lớp/course trong Moodle.' },
  courseid: { type: 'string', description: 'Moodle course ID. Nếu bỏ trống sẽ dùng DEFAULT_COURSEID.' },
  group_name: { type: 'string', description: 'Tên group/cohort nếu cần lọc trong lớp.' },
  groupid: { type: 'string', description: 'Moodle group ID nếu biết.' },
};

const tools = [
  {
    name: 'test_connection',
    description: 'Kiểm tra kết nối từ Xiaozhi/imcp MCP server tới DAMI Moodle Robot API. Chỉ dùng để test kỹ thuật.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_student',
    description: 'Tìm học viên theo tên/email/userid và lớp/course/group. Dùng khi giáo viên vừa nhắc tên học viên hoặc khi cần phân biệt trùng tên.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_summary',
    description: 'Dùng khi giáo viên hỏi tổng quan/tình hình học tập của một học viên: điểm danh, bài thiếu, đình chỉ/bảo lưu, điểm gần nhất, DAMI level/EXP.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_attendance',
    description: 'Dùng khi hỏi điểm danh, đi học, nghỉ/vắng, trễ, cảnh báo C/D, nghỉ buổi nào hoặc lịch sử điểm danh gần đây của học viên.',
    inputSchema: {
      type: 'object',
      properties: { ...studentBaseSchema, limit: { type: 'number', description: 'Số bản ghi gần đây cần xem, ví dụ 10.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_missing_homework',
    description: 'Dùng khi hỏi học viên còn thiếu bài/nợ bài/chưa làm bài online nào. Không dùng cho câu hỏi thiếu bao nhiêu điểm.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_suspend_status',
    description: 'Dùng khi hỏi học viên có bị đình chỉ, khóa nick, bảo lưu, vi phạm, chờ xóa hoặc nguy cơ bị khóa chưa.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_dami_status',
    description: 'Dùng khi hỏi điểm chăm chỉ/chuyên cần, giờ học, ngày học, streak, EXP, level DAMI, energy hoặc xếp hạng của học viên.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_latest_scores',
    description: 'Dùng khi hỏi điểm gần nhất, điểm LR/Speaking/Writing, full test mới nhất, phần/part yếu nhất, phần/part mạnh nhất của học viên.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_fulltest_history',
    description: 'Dùng khi hỏi lịch sử FULL TEST/LR, các bài FULL TEST gần nhất, 3-5 bài gần đây, điểm tăng hay giảm, xu hướng điểm hoặc tiến bộ qua các FULL TEST.',
    inputSchema: {
      type: 'object',
      properties: { ...studentBaseSchema, limit: { type: 'number', description: 'Số bài FULL TEST/LR gần nhất cần xem, mặc định 5.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_student_goal_status',
    description: 'Dùng khi hỏi mục tiêu điểm thi, ngày thi, còn thiếu bao nhiêu điểm để đạt mục tiêu, đã đạt mục tiêu chưa hoặc tiến độ mục tiêu của học viên.',
    inputSchema: {
      type: 'object',
      properties: studentBaseSchema,
      additionalProperties: false,
    },
  },
  {
    name: 'get_course_risk_students',
    description: 'Dùng khi hỏi trong lớp/course có ai rủi ro, ai thiếu bài, ai chăm chỉ thấp, ai sắp bị đình chỉ hoặc cần nhắc nhở.',
    inputSchema: {
      type: 'object',
      properties: {
        course_name: studentBaseSchema.course_name,
        courseid: studentBaseSchema.courseid,
        group_name: studentBaseSchema.group_name,
        groupid: studentBaseSchema.groupid,
        limit: { type: 'number', description: 'Số học viên tối đa trả về.' },
      },
      additionalProperties: false,
    },
  },
];

const server = new Server(
  {
    name: 'damirobot-mcp-server',
    version: '0.1.9',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};
  const allowed = new Set(tools.map((t) => t.name));
  if (!allowed.has(name)) {
    return textResult(`Tool không hợp lệ: ${name}`, true);
  }
  return await callMoodle(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
