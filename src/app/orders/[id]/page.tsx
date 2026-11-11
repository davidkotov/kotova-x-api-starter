import type { Metadata } from 'next';
import OrderView from '@/components/OrderView';

export const metadata: Metadata = { title: 'Order | Swap starter' };

export default function OrderPage({ params }: { params: { id: string } }) {
  // A stray "%" in the URL must not become a 500: the id is checked by OrderView.
  let id = params.id;
  try {
    id = decodeURIComponent(params.id);
  } catch {
    // Keep it as typed; OrderView answers "Order ids look like X-AB12CD."
  }
  return <OrderView id={id} />;
}
