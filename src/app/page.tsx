export default function HomePage() {
  return (
    <section className="surface-card p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-500">HCA Stats Runner</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Service online</h1>
      <p className="mt-2 text-sm muted-copy">The stats worker is running. Open `/stats` to access the protected UI.</p>
    </section>
  );
}
