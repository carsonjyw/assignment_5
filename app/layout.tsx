import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
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
  title: "Headway",
  description: "Live NYC subway arrivals for the stations you follow.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ClerkProvider>
          <header className="flex h-16 items-center justify-between border-b border-black/10 px-4 sm:px-6 dark:border-white/15">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Headway
            </Link>
            <nav className="flex items-center gap-3 text-sm font-medium">
              <Suspense>
                <Show when="signed-out">
                  <SignInButton>
                    <button className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10">
                      Sign in
                    </button>
                  </SignInButton>
                  <SignUpButton>
                    <button className="rounded-full bg-foreground px-4 py-2 text-background hover:opacity-90">
                      Sign up
                    </button>
                  </SignUpButton>
                </Show>
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </Suspense>
            </nav>
          </header>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
