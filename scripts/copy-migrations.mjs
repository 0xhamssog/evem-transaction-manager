import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/src/persistence/migrations', { recursive: true });
cpSync('src/persistence/migrations/001_init.sql', 'dist/src/persistence/migrations/001_init.sql');
