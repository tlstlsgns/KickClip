/**
 * AuthProvider
 * 
 * React Context Provider for authentication state.
 * Consumes auth state from preload script (IPC) - does NOT import Firebase directly.
 */

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';

interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    // Check if electronAPI is available
    if (!window.electronAPI || !window.electronAPI.auth) {
      console.error('electronAPI.auth is not available');
      setLoading(false);
      return;
    }

    // Get initial auth state
    const initializeAuth = async () => {
      try {
        const currentUser = await window.electronAPI.auth.getCurrentUser();
        setUser(currentUser);
      } catch (error) {
        console.error('Error getting initial auth state:', error);
      } finally {
        // Set loading to false after initial state is resolved
        setLoading(false);
      }
    };

    initializeAuth();

    // Listen for auth state changes
    const unsubscribe = window.electronAPI.auth.onAuthStateChanged((userData: User | null) => {
      setUser(userData);
      // Ensure loading is false when we receive auth state updates
      setLoading(false);
    });

    // Cleanup: unsubscribe when component unmounts
    return () => {
      unsubscribe();
    };
  }, []);

  const value: AuthContextType = {
    user,
    loading,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * Hook to use auth context
 */
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

