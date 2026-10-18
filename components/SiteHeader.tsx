import Link from "next/link";

export default function SiteHeader({ current, children }: { current: "scan" | "train" | "accuracy"; children?: React.ReactNode }) {
  const links = [
    { href: "/", label: "Scan", key: "scan" },
    { href: "/train", label: "Train", key: "train" },
    { href: "/accuracy", label: "Accuracy test", key: "accuracy" },
  ] as const;
  return (
    <header className="masthead">
      <Link href="/" className="brand">
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <rect x="1" y="1" width="26" height="26" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <rect x="1" y="1" width="13" height="13" fill="currentColor" />
          <rect x="14" y="14" width="13" height="13" fill="currentColor" />
        </svg>
        <span>Scoresheet Scanner</span>
      </Link>
      <nav className="site-nav" aria-label="Main">
        {links.map((l) => (
          <Link key={l.key} href={l.href} aria-current={current === l.key ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
        {children}
      </nav>
    </header>
  );
}
