import SwapForm from '@/components/SwapForm';

export default function HomePage() {
  return (
    <>
      <div className="page-head">
        <h1>Swap</h1>
        <p className="muted">Get the best offer across sources, then create the order.</p>
      </div>
      <SwapForm />
    </>
  );
}
