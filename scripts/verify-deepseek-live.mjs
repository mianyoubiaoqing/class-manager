/**
 * DeepSeek 真实合成连接连通性验证脚本
 *
 * 依据工单 03:
 * “测试：用替身覆盖异常与密钥不泄漏；获得本地配置后各执行一条真实合成文本/图像请求。无配置时标受阻，禁止假通过。”
 */

function maskApiKey(apiKey) {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

const rawKey = process.env.DEEPSEEK_API_KEY?.trim();

if (!rawKey) {
  console.log('====================================================');
  console.log('【DeepSeek 真实接口验证状态】：受阻 (BLOCKED)');
  console.log('原因：未在运行环境中检测到 DEEPSEEK_API_KEY。');
  console.log('依据工单 03 验收标准：无真实配置时标受阻，严禁以测试替身伪造通过。');
  console.log('后续在具备已授权 DeepSeek 账号的机器上，可运行：');
  console.log('  $env:DEEPSEEK_API_KEY="sk-..." ; node scripts/verify-deepseek-live.mjs');
  console.log('执行最终真机验证。');
  console.log('====================================================');
  process.exit(0);
}

console.log('====================================================');
console.log(`检测到已配置凭据 (掩码: ${maskApiKey(rawKey)})，开始真实合成检查...`);
console.log('====================================================');

const BASE_URL = 'https://api.deepseek.com';
const SYNTHETIC_TEST_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function sendRequest(body) {
  const startTime = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${rawKey}`,
    },
    body: JSON.stringify(body),
  });

  const durationMs = Date.now() - startTime;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.replaceAll(rawKey, '***')}`);
  }
  const data = await res.json();
  return { data, durationMs };
}

try {
  console.log('\n[1/2] 正在向 DeepSeek 发起真实合成文本请求 (Ping v1)...');
  const textBody = {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Ping' }],
    max_tokens: 5,
    thinking: { type: 'disabled' },
  };
  const { data: textData, durationMs: textDuration } = await sendRequest(textBody);
  console.log('  -> 状态: 成功 (PASS)');
  console.log(`  -> 响应 ID: ${textData.id ?? '未知'}`);
  console.log(`  -> 实际模型: ${textData.model}`);
  console.log(`  -> 耗时: ${textDuration}ms`);
  console.log(
    `  -> 用量: Total ${textData.usage?.total_tokens} tokens (Prompt: ${textData.usage?.prompt_tokens}, Completion: ${textData.usage?.completion_tokens})`,
  );

  console.log('\n[2/2] 正在向 DeepSeek 发起真实微型图像合成请求 (Vision v1)...');
  const visionBody = {
    model: 'deepseek-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'image_url', image_url: { url: SYNTHETIC_TEST_IMAGE_DATA_URL } },
        ],
      },
    ],
    max_tokens: 5,
    thinking: { type: 'disabled' },
  };
  const { data: visionData, durationMs: visionDuration } = await sendRequest(visionBody);
  console.log('  -> 状态: 成功 (PASS)');
  console.log(`  -> 响应 ID: ${visionData.id ?? '未知'}`);
  console.log(`  -> 实际模型: ${visionData.model}`);
  console.log(`  -> 耗时: ${visionDuration}ms`);
  console.log(
    `  -> 用量: Total ${visionData.usage?.total_tokens} tokens (Prompt: ${visionData.usage?.prompt_tokens}, Completion: ${visionData.usage?.completion_tokens})`,
  );

  console.log('\n====================================================');
  console.log('【DeepSeek 真实接口验证通过】：文本与视觉多模态均连通正常。');
  console.log('====================================================');
} catch (error) {
  console.error('\n【DeepSeek 真实接口验证失败】：', error.message || error);
  process.exit(1);
}
