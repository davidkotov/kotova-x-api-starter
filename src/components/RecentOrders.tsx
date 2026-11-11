'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import KotovaXMark from './KotovaXMark';
import { readRecentOrders, type RecentOrder } from '@/lib/kx/recent-orders';
import { formatTime } from '@/lib/format';

/** Orders created from this browser. The account-wide list is GET /orders. */
export default function RecentOrders() {
  const [orders, setOrders] = useState<RecentOrder[]>([]);
  useEffect(() => setOrders(readRecentOrders()), []);
  if (orders.length === 0) return null;
  const provider = orders.find((o) => o.provider)?.provider ?? null;
  return (
    <section aria-labelledby="recent-title">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2 id="recent-title" className="section-title" style={{ margin: 0 }}>
          Orders from this browser
        </h2>
        <KotovaXMark provider={provider} prefix="via" />
      </div>
      <ul className="recent">
        {orders.slice(0, 8).map((o) => (
          <li key={o.id}>
            <Link href={`/orders/${o.id}`}>
              <span className="mono">{o.id}</span>
              <span className="muted" style={{ flex: 1 }}>
                {o.from} &rarr; {o.to}
                {o.source ? ` · ${o.source}` : ''}
              </span>
              <span className="small faint">{formatTime(o.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
