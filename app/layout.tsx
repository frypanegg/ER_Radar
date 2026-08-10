import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "노사교섭 레이더 | 교섭상태 프레임워크",
  description: "한국 대기업 원청 직접고용 노조의 임금·단체교섭 상태를 위한 프레임워크 데모",
  openGraph: {
    title: "노사교섭 레이더",
    description: "원청 직접고용 노조의 임금·단체교섭 상태 프레임워크",
    images: [
      {
        url: "/social/collective-bargaining-radar-og.png",
        width: 1609,
        height: 977,
        alt: "교섭 단계와 근거를 나타낸 노사교섭 레이더 일러스트",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/social/collective-bargaining-radar-og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
