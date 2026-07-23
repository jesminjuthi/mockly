import type { Metadata } from "next";
import "./globals.css";

const publicBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const publicSiteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mockly-private-tests.nouchhyecha152.chatgpt.site";

export const metadata: Metadata = {
  metadataBase: new URL(publicSiteUrl),
  title: "Mockly — আপনার প্রশ্ন, আপনার পরীক্ষা",
  description: "PDF ও নিজের প্রশ্ন থেকে ব্যক্তিগত, গোপনীয় মক টেস্ট তৈরি করুন।",
  openGraph: {
    title: "Mockly — আপনার প্রশ্ন, আপনার পরীক্ষা",
    description: "PDF দিন, প্রশ্ন বাছুন, পরীক্ষা শুরু করুন—কোনো স্থায়ী স্টোরেজ ছাড়াই।",
    images: [`${publicBasePath}/og.png`],
  },
  twitter: {
    card: "summary_large_image",
    title: "Mockly — আপনার প্রশ্ন, আপনার পরীক্ষা",
    description: "PDF দিন, প্রশ্ন বাছুন, পরীক্ষা শুরু করুন।",
    images: [`${publicBasePath}/og.png`],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="bn">
      <body>{children}</body>
    </html>
  );
}
