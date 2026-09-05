import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? '127.0.0.1',

  port: Number(
    process.env.DATABASE_PORT ?? '55432',
  ),

  dbName:
    process.env.DATABASE_NAME ??
    'jungle_wagering',

  user:
    process.env.DATABASE_USER ??
    'jungle',

  password:
    process.env.DATABASE_PASSWORD ??
    'jungle',

  extensions: [
    Migrator,
  ],

  entities: [
    './dist/**/*.entity.js',
  ],

  entitiesTs: [
    './src/**/*.entity.ts',
  ],

  migrations: {
    path:
      './dist/migrations',

    pathTs:
      './src/migrations',
  },

  debug:
    process.env.NODE_ENV ===
    'development',
});
