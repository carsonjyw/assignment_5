// Public connection details. Both values are designed to be public (the publishable key only grants
// what RLS allows), so they may be committed; environment variables override them when set.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://fddulhtbsrrzepgehdhi.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_ocq0p8AzqRcrEZ8H6XxzSw_JQMokL74";
