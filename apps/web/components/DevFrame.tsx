'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { DEV_TOAST_EVENT, type DevToastDetail } from '@/lib/shopify';

const NAV = [
  { href: '/generations', label: 'Generations' },
  { href: '/products', label: 'Products' },
];

const styles: Record<string, CSSProperties> = {
  root: { minHeight: '100vh', background: '#f1f1f1', fontFamily: 'Inter, system-ui, sans-serif' },
  bar: { height: 48, background: '#1a1a1a', color: '#fff', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 13, gap: 12 },
  layout: { display: 'flex' },
  nav: { width: 200, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 },
  main: { flex: 1, minWidth: 0, padding: '0 16px 32px' },
  toast: { position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#1a1a1a', color: '#fff', padding: '8px 16px', borderRadius: 8, fontSize: 13, zIndex: 100 },
};

// Development stand-in for the Shopify admin chrome. It only renders outside the admin (plain tab or mock
// mode) and is deliberately plain: inside the admin, Shopify draws the real frame.
export function DevFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [toast, setToast] = useState<DevToastDetail | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const onToast = (event: Event) => {
      setToast((event as CustomEvent<DevToastDetail>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(null), 3000);
    };
    window.addEventListener(DEV_TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(DEV_TOAST_EVENT, onToast);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div style={styles.root}>
      <div style={styles.bar}>Retailer Studio (development preview, not the Shopify admin)</div>
      <div style={styles.layout}>
        <nav style={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{ padding: '6px 12px', borderRadius: 8, fontSize: 13, textDecoration: 'none', color: '#303030', background: pathname.startsWith(item.href) ? '#fafafa' : 'transparent', fontWeight: pathname.startsWith(item.href) ? 650 : 550 }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main style={styles.main}>{children}</main>
      </div>
      {toast ? (
        <div role="status" style={{ ...styles.toast, background: toast.isError ? '#c70a24' : '#1a1a1a' }}>
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
