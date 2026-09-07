"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from "react";
import { supabase } from "@/lib/supabase";

interface User {
    id: string;
    email: string;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SESSION_CHECK_TIMEOUT_MS = 2500;

function sessionCheckTimeout(): Promise<null> {
    return new Promise((resolve) => {
        window.setTimeout(() => resolve(null), SESSION_CHECK_TIMEOUT_MS);
    });
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    useEffect(() => {
        let active = true;

        const checkUser = async () => {
            try {
                const result = await Promise.race([
                    supabase.auth.getSession(),
                    sessionCheckTimeout(),
                ]);
                if (!active) return;

                const session = result?.data.session;
                if (session?.user) {
                    setUser({
                        id: session.user.id,
                        email: session.user.email || "",
                    });
                } else {
                    setUser(null);
                }
            } catch {
                if (active) setUser(null);
            } finally {
                if (active) setAuthLoading(false);
            }
        };

        checkUser();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange(async (_event, session) => {
            if (!active) return;
            if (session?.user) {
                setUser({
                    id: session.user.id,
                    email: session.user.email || "",
                });
            } else {
                setUser(null);
            }
            setAuthLoading(false);
        });

        return () => {
            active = false;
            subscription.unsubscribe();
        };
    }, []);

    const signOut = async () => {
        await supabase.auth.signOut();
        setUser(null);
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                signOut,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
