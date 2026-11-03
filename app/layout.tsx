import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { BottomTabs, TopTabs } from "@/components/Nav";
import { ConnectionBar, LiveBadge } from "@/components/Status";
import { ThemeToggle } from "@/components/ThemeToggle";
import { THEME_KEY } from "@/lib/theme";
import { LiveProvider } from "./providers";
import "./globals.css";

const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], weight: ["500", "600", "700", "800", "900"] });

export const metadata: Metadata = {
  title: "HEADWAY",
  description: "Live NYC subway arrivals, an interactive network map, and trip planning for every line.",
};

export const viewport: Viewport = { themeColor: "#000000" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the script below may set data-theme on <html> before React hydrates
    <html lang="en" className={`${interTight.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* apply the saved appearance before first paint (no flash); Auto = follow the device */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}` }} />
      </head>
      <body className="flex h-full flex-col">
        <ClerkProvider>
          <LiveProvider>
            <header className="z-30 bg-sign text-sign-text">
              <div className="flex h-14 items-center gap-6 px-4 md:px-5">
                <Link href="/" className="flex items-center gap-2 text-[17px] font-black tracking-[0.14em]" aria-label="HEADWAY, home">
                  {/* wordmark: a white bar over the name, echoing the sign pinstripe */}
                  <span aria-hidden="true" className="flex flex-col gap-[3px]"><i className="block h-[3px] w-5 bg-sign-text" /><i className="block h-[3px] w-3.5 bg-sign-text/60" /></span>
                  HEADWAY
                </Link>
                <TopTabs />
                <div className="ml-auto flex items-center gap-2 sm:gap-4">
                  <LiveBadge />
                  <ThemeToggle />
                  <Suspense>
                    <Show when="signed-out">
                      <SignInButton>
                        <button className="press min-h-10 whitespace-nowrap rounded-full border border-sign-text/60 px-3.5 text-sm font-bold hover:border-sign-text hover:bg-sign-text hover:text-sign">
                          Sign in
                        </button>
                      </SignInButton>
                    </Show>
                    <Show when="signed-in">
                      <UserButton />
                    </Show>
                  </Suspense>
                </div>
              </div>
              <ConnectionBar />
            </header>
            {children}
            <BottomTabs />
          </LiveProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
