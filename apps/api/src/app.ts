import { Elysia } from 'elysia';

export const app = new Elysia()
  .get('/health', () => ({ status: 'ok', service: 'itc-field-source-api' }));

export type App = typeof app;
