// ローカル実行用: npm start（.env を読み込む） / npm run dry-run（LLM・Webhookを呼ばない）
import { handler } from './handler.mjs';

const dryRun = process.argv.includes('--dry-run');
const result = await handler({ dryRun });
console.log(result);
