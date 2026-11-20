// ESLint 9 flat config (Next.js 16 removed `next lint`; run `pnpm lint`).
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  {
    // eslint-plugin-react-hooks 7 (with eslint-config-next 16) reports these
    // React Compiler guidelines as errors. The patterns they flag here (state
    // reset in an effect when an input changes; the "latest callback" ref
    // written during render) work under React 19; they stay visible as
    // warnings until they are refactored.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'src/lib/kx/api-types.ts']),
]);
