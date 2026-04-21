/**
 * SignInButton
 * 
 * Button component for Google Sign-in.
 * Calls preload-exposed API - does NOT depend on Firebase SDK directly.
 */

import React, { useState } from 'react';

interface SignInButtonProps {
  className?: string;
  children?: React.ReactNode;
}

export const SignInButton: React.FC<SignInButtonProps> = ({ 
  className = '',
  children 
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    // Check if electronAPI is available
    if (!window.electronAPI || !window.electronAPI.auth) {
      setError('Authentication API is not available');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.auth.signInWithGoogle();
      
      if (!result.success) {
        setError(result.error || 'Failed to sign in');
      }
      // If successful, auth state will be updated via onAuthStateChanged listener
    } catch (err: any) {
      console.error('Error signing in:', err);
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleSignIn}
        disabled={isLoading}
        className={className}
        style={{
          padding: '10px 20px',
          fontSize: '14px',
          fontWeight: 500,
          color: '#fff',
          backgroundColor: isLoading ? '#ccc' : '#4285f4',
          border: 'none',
          borderRadius: '4px',
          cursor: isLoading ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        {isLoading ? (
          <span>Signing in...</span>
        ) : (
          children || <span>Sign in with Google</span>
        )}
      </button>
      {error && (
        <div style={{ color: 'red', marginTop: '8px', fontSize: '12px' }}>
          {error}
        </div>
      )}
    </div>
  );
};

