import { createClient } from "@supabase/supabase-js";

// Public values only. Set both in Cloudflare build variables (see setup steps).
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key) : null;
