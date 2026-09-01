import type { Metadata } from 'next';
import { Geist, Geist_Mono, Newsreader } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const newsreader = Newsreader({ variable: '--font-newsreader', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: 'Lavish Library',
  description: 'Your private, local archive of Lavish review surfaces.',
  openGraph: {
    title: 'Lavish Library',
    description: 'Your creative archive, finally in one place.',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'Lavish Library' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Lavish Library',
    description: 'Your creative archive, finally in one place.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable}`}>{children}</body></html>;
}
