'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { isEmbedded, MOCK } from '@/lib/shopify';
import { DevFrame } from './DevFrame';
import { OutsideAdmin } from './OutsideAdmin';

export const NAV_LINKS = [
  { href: '/generations', label: 'Generations' },
  { href: '/products', label: 'Products' },
] as const;

type Mode = 'unknown' | 'embedded' | 'dev' | 'outside';

// Inside the Shopify admin, App Bridge draws the real top bar and navigation: this component only declares
// the navigation links (s-app-nav) and handles the navigate events App Bridge fires when one is clicked.
// In a plain tab (mock mode, local development) a minimal dev frame stands in for the admin.
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('unknown');

  useEffect(() => {
    // Outside the admin: the development frame in mock mode, a "open it from Shopify" page otherwise.
    setMode(isEmbedded() ? 'embedded' : MOCK ? 'dev' : 'outside');
  }, []);

  useEffect(() => {
    const onNavigate = (event: Event) => {
      const href = (event.target as Element | null)?.getAttribute('href');
      if (href) router.push(href);
    };
    document.addEventListener('shopify:navigate', onNavigate);
    return () => document.removeEventListener('shopify:navigate', onNavigate);
  }, [router]);

  if (mode === 'dev') return <DevFrame>{children}</DevFrame>;
  if (mode === 'outside') return <OutsideAdmin />;
  return (
    <>
      <s-app-nav>
        {NAV_LINKS.map((link) => (
          <s-link key={link.href} href={link.href}>
            {link.label}
          </s-link>
        ))}
      </s-app-nav>
      {children}
    </>
  );
}
