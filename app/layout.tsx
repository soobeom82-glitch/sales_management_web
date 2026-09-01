import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sales Sentinel",
  description: "VMMS와 EasyShop 거래 이상 감시",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

