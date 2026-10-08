import express from 'express';
import { createApp } from './src/http/app.js';
import { createRuntimeGate } from './src/http/runtime-gate.js';
import { createRuntime } from './src/runtime.js';

const app = express();

let mounted = false;
const gate = createRuntimeGate(async () => {
  const ctx = await createRuntime();
  if (!mounted) {
    app.use(createApp(ctx));
    mounted = true;
  }
  return ctx;
});

// 冷啟動先暖；失敗只記 log，之後的請求會重新初始化，不會被壞掉的 Promise 卡死。
gate.warmup((error) => {
  console.error('[newsletter-kit] 初始化失敗，等下一個請求重試', error.message);
});

app.use((req, res, next) => {
  gate.ready().then(() => next(), next);
});

export default app;
