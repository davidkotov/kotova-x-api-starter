import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { apiBase, SHOW_CONFIG_DETAILS } from '@/lib/kx/server';

export const metadata: Metadata = {
  title: 'Swap starter',
  description: 'Example integration of the Kotova X API: quotes, orders and order tracking.',
  formatDetection: { email: false, address: false, telephone: false, date: false },
};

export const viewport: Viewport = { themeColor: '#ffffff', colorScheme: 'light' };

// The header badge (development only) follows KOTOVA_API_BASE at runtime, without a rebuild.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Which API this app calls is deployment configuration: shown only outside production.
  const base = SHOW_CONFIG_DETAILS ? apiBase() : null;
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="1" y="1" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M6 9h11l-3-3M18 15H7l3 3" fill="none" stroke="#2563eb" strokeWidth="2" />
              </svg>
              Swap starter
            </Link>
            {base && (
              <span className="badge" title={base.ok ? 'The API this app calls (KOTOVA_API_BASE); shown in development only' : base.problem}>
                API: {base.ok ? base.host : 'not configured'}
              </span>
            )}
          </div>
        </header>
        <main className="page">{children}</main>
        <footer className="site-footer">
          <div className="site-footer-inner">
            <span>Example integration of the Kotova X API.</span>
            <a href="https://docs.kotova.io/x/api" target="_blank" rel="noopener noreferrer">
              API docs
            </a>
            <a href="https://docs.kotova.io/x/api/display-requirements" target="_blank" rel="noopener noreferrer">
              Display requirements
            </a>
            <a href="https://kotova.io/terms/api" target="_blank" rel="noopener noreferrer">
              API Terms
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
