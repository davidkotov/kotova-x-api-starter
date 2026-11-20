import type { Metadata } from 'next';
import OrderView from '@/components/OrderView';

export const metadata: Metadata = { title: 'Order | Convert Crypto' };

// Next.js 15+: route params arrive as a Promise.
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  // A stray "%" in the URL must not become a 500: the id is checked by OrderView.
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Keep it as typed; OrderView answers "Order ids look like X-AB12CD."
  }
  return <OrderView id={id} />;
}
