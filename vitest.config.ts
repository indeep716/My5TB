import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['cloud/tests/**/*.test.ts'],testTimeout:30000,hookTimeout:30000}});
