import express from 'express';
import { createApp } from './src/http/app.js';
import { createRuntime } from './src/runtime.js';

const app = express();

const ready = createRuntime().then((ctx) => {
  app.use(createApp(ctx));
  return ctx;
});

app.use((req, res, next) => {
  void ready.then(() => next()).catch(next);
});

export default app;
