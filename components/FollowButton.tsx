"use client";

// ☆ Save / ★ Saved: the station's primary action. Optimistic, labelled, never icon-only. Signed-out riders are sent to
// sign-in and the follow completes on return (?follow=1), so they never tap twice.
import { useAuth, useClerk } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "@/app/providers";
import { setSavedLines } from "@/lib/headway/savedLines";

type Msg = { text: string; undo?: boolean } | null;

// `line`: the line this station page is filtered to. Saving then keeps just that line on the Saved card.
export function FollowButton({ stationId, stationName, line = null }: { stationId: number; stationName: string; line?: string | null }) {
  const { supabase, routes } = useLive();
  const lineName = line ? routes[line]?.short_name ?? line : null;
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const [followingState, setFollowing] = useState<boolean | null>(null);
  // Signed-out riders are never "following"; no state write needed for that case
  const following = isLoaded && !isSignedIn ? false : followingState;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const autoFollowDone = useRef(false);

  // Current state (RLS returns only this user's rows)
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    supabase.from("follows").select("station_id").eq("station_id", stationId).maybeSingle().then(({ data }) => {
      if (!cancelled) setFollowing(!!data);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, isLoaded, isSignedIn, stationId]);

  const follow = useCallback(async () => {
    setBusy(true);
    setFollowing(true);
    const { error } = await supabase.from("follows").insert({ station_id: stationId });
    setBusy(false);
    if (error && error.code !== "23505") {
      setFollowing(false);
      setMsg({ text: error.message.includes("follow_limit")
        ? "You've saved 12 stations, the maximum. Remove one to add another."
        : "Couldn't save. Try again." });
      return;
    }
    if (line) setSavedLines(stationId, [line]);
    setMsg({ text: lineName ? `Saved ${stationName}, ${lineName} only` : `Saved ${stationName}` });
  }, [supabase, stationId, stationName, line, lineName]);

  const unfollow = useCallback(async () => {
    setBusy(true);
    setFollowing(false);
    const { error } = await supabase.from("follows").delete().eq("station_id", stationId);
    setBusy(false);
    if (error) {
      setFollowing(true);
      setMsg({ text: "Couldn't save. Try again." });
      return;
    }
    setSavedLines(stationId, []);
    setMsg({ text: `Removed ${stationName} from Saved`, undo: true });
  }, [supabase, stationId, stationName]);

  // Returning from sign-in with ?follow=1: finish the follow, then clean the URL
  useEffect(() => {
    if (!isSignedIn || following === null || autoFollowDone.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("follow") !== "1") return;
    autoFollowDone.current = true;
    url.searchParams.delete("follow");
    window.history.replaceState(null, "", url.pathname + url.search);
    if (following) return;
    supabase.from("follows").insert({ station_id: stationId }).then(({ error }) => {
      const saved = !error || error.code === "23505";
      setFollowing(saved);
      if (saved && line) setSavedLines(stationId, [line]);
      setMsg({ text: saved ? (lineName ? `Saved ${stationName}, ${lineName} only` : `Saved ${stationName}`) : "Couldn't save. Try again." });
    });
  }, [isSignedIn, following, supabase, stationId, stationName, line, lineName]);

  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), msg.undo ? 6000 : 4000);
    return () => clearTimeout(id);
  }, [msg]);

  const onClick = () => {
    if (!isSignedIn) {
      void clerk.openSignIn({ forceRedirectUrl: `/station/${stationId}?follow=1${line ? `&line=${encodeURIComponent(line)}` : ""}` });
      return;
    }
    if (following) void unfollow();
    else void follow();
  };

  const signedOut = isLoaded && !isSignedIn;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || following === null}
        aria-pressed={!!following}
        aria-describedby={signedOut ? `save-hint-${stationId}` : undefined}
        title={signedOut ? "Sign in to save this station" : undefined}
        className={`press inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-sm font-extrabold disabled:opacity-70 ${
          following ? "border-2 border-sign-text/70 text-sign-text hover:border-sign-text" : "bg-sign-text text-sign hover:bg-[#e8e8e6]"
        }`}
      >
        {/* key restarts the pop each time the state flips */}
        <span key={String(following)} className={following ? "pop text-[#ffd166]" : undefined} aria-hidden="true">{following ? "★" : "☆"}</span>
        {following ? "Saved" : lineName ? `Save ${lineName} only` : "Save"}
      </button>
      {signedOut && <span id={`save-hint-${stationId}`} className="sr-only">Sign in to save this station</span>}
      {/* messages float under the button, so they never push the arrivals down */}
      <p role="status" className={`absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded-lg bg-[#26292e] px-3 py-1.5 text-xs font-semibold text-sign-text shadow-lg ${msg ? "enter" : "sr-only"}`}>
        {msg?.text}
        {msg?.undo && (
          <button type="button" className="ml-2 underline" onClick={() => void follow()}>
            Undo
          </button>
        )}
      </p>
    </div>
  );
}
