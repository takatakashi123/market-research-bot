import Anthropic from '@anthropic-ai/sdk';

/**
 * JSONスキーマで出力形式を固定してClaudeを呼び出す、共通のクライアント。
 * 候補が多い日は入出力が長くなるため、ストリーミングで受け取ってから最終結果を使う。
 */
export function createLlm({ apiKey, model }) {
  const client = new Anthropic({ apiKey });

  return {
    async json({ system, user, schema, effort = 'low', maxTokens = 16000 }) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: maxTokens,
        // 安全分類器による拒否時は、サーバー側で推奨モデルに自動フォールバック
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort,
          format: { type: 'json_schema', schema },
        },
        system,
        messages: [{ role: 'user', content: user }],
      });
      const response = await stream.finalMessage();

      if (response.stop_reason === 'refusal') {
        throw new Error(`リクエストが拒否されました (${response.stop_details?.category ?? 'unknown'})`);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('出力が max_tokens で途切れました');
      }
      const text = response.content.find((block) => block.type === 'text')?.text;
      if (!text) throw new Error('応答にテキストが含まれていません');
      return JSON.parse(text);
    },
  };
}
