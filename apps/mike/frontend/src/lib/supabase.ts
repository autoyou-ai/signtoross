import { createClient } from "@supabase/supabase-js";

// Docker's gateway serves auth on both the local and public origins. Resolve
// its optional proxy path in the browser so local login does not require DNS.
const proxyPath = process.env.NEXT_PUBLIC_SUPABASE_PROXY_PATH;
const supabaseUrl =
    proxyPath && typeof window !== "undefined"
        ? new URL(proxyPath, window.location.origin).toString()
        : process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
