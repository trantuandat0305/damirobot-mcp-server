import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startFakeMoodle() {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      reply_text: `FAKE_OK:${payload.tool || 'unknown'}`,
      emotion: 'neutral',
      student: { id: 123, name: payload.student_name || 'Test Student' },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    reset: () => { calls = 0; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startMcp(fakeMoodleUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MOODLE_BASE_URL: fakeMoodleUrl,
      MOODLE_TOOL_ENDPOINT: '/tool',
      MOODLE_API_TOKEN: 'test-token',
      REQUEST_TIMEOUT_MS: '1000',
      MCP_SPEAKER_GUARD: '1',
      ALLOWED_SPEAKER_IDS: '',
      LOG_LEVEL: 'debug',
      ...extraEnv,
    },
  });

  let stdout = '';
  const pending = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    while (true) {
      const pos = stdout.indexOf('\n');
      if (pos < 0) break;
      const line = stdout.slice(0, pos).trim();
      stdout = stdout.slice(pos + 1);
      if (!line) continue;
      const waiter = pending.shift();
      if (waiter) waiter.resolve(JSON.parse(line));
    }
  });
  child.on('exit', (code) => {
    while (pending.length) pending.shift().reject(new Error(`MCP exited with ${code}`));
  });

  let nextId = 1;
  function call(name, args = {}, extraParams = {}) {
    const id = nextId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args, ...extraParams },
    };
    const response = new Promise((resolve, reject) => pending.push({ resolve, reject }));
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return response;
  }

  async function stop() {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await once(child, 'exit');
  }

  return { child, call, stop };
}

function resultText(response) {
  return response?.result?.content?.map((item) => item.text || '').join('\n') || '';
}

test('missing speakerId is fail-closed and never reaches Moodle', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url);
  try {
    const response = await mcp.call('find_student', { student_name: 'Nguyen Van A' });
    assert.match(resultText(response), /chưa được nhận diện/i);
    assert.equal(response.result.isError, true);
    assert.equal(moodle.calls(), 0);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});

test('LLM cannot spoof authorization by putting speakerId inside arguments', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url);
  try {
    const response = await mcp.call('get_student_summary', {
      student_name: 'Nguyen Van A',
      speakerId: 'fake-speaker-from-arguments',
    });
    assert.match(resultText(response), /chưa được nhận diện/i);
    assert.equal(moodle.calls(), 0);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});

test('recognized Xiaozhi speakerId is allowed when automatic registered-speaker mode is used', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url);
  try {
    const response = await mcp.call(
      'get_student_summary',
      { student_name: 'Nguyen Van A' },
      { speakerId: 'registered-speaker-123' },
    );
    assert.match(resultText(response), /FAKE_OK:get_student_summary/);
    assert.equal(response.result.isError, false);
    assert.equal(moodle.calls(), 1);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});

test('_meta.speakerId fallback is accepted because Xiaozhi may mirror metadata there', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url);
  try {
    const response = await mcp.call(
      'get_student_attendance',
      { student_name: 'Nguyen Van A' },
      { _meta: { speakerId: 'registered-speaker-meta' } },
    );
    assert.match(resultText(response), /FAKE_OK:get_student_attendance/);
    assert.equal(moodle.calls(), 1);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});

test('explicit allowlist rejects other recognized speakers and accepts listed speakers', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url, { ALLOWED_SPEAKER_IDS: 'teacher-1, teacher-2' });
  try {
    let response = await mcp.call(
      'get_missing_homework',
      { student_name: 'Nguyen Van A' },
      { speakerId: 'student-voiceprint' },
    );
    assert.match(resultText(response), /chưa được nhận diện/i);
    assert.equal(moodle.calls(), 0);

    response = await mcp.call(
      'get_missing_homework',
      { student_name: 'Nguyen Van A' },
      { speakerId: 'teacher-2' },
    );
    assert.match(resultText(response), /FAKE_OK:get_missing_homework/);
    assert.equal(moodle.calls(), 1);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});

test('blocked request clears previous student context', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url);
  try {
    let response = await mcp.call(
      'find_student',
      { student_name: 'Old Student' },
      { speakerId: 'teacher-1' },
    );
    assert.match(resultText(response), /FAKE_OK:find_student/);
    assert.equal(moodle.calls(), 1);

    response = await mcp.call('get_student_summary', {});
    assert.match(resultText(response), /chưa được nhận diện/i);
    assert.equal(moodle.calls(), 1);

    moodle.reset();
    response = await mcp.call(
      'get_student_summary',
      {},
      { speakerId: 'teacher-1' },
    );
    assert.match(resultText(response), /FAKE_OK:get_student_summary/);
    assert.equal(moodle.calls(), 1);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});

test('technical test_connection remains available without speaker identity', async () => {
  const moodle = await startFakeMoodle();
  const mcp = startMcp(moodle.url);
  try {
    const response = await mcp.call('test_connection');
    assert.match(resultText(response), /FAKE_OK:test_connection/);
    assert.equal(moodle.calls(), 1);
  } finally {
    await mcp.stop();
    await moodle.close();
  }
});
