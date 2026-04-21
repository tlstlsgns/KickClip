/**
 * SignOutButton
 * 
 * Button component for signing out.
 * Calls preload-exposed API - does NOT depend on Firebase SDK directly.
 */

import React, { useState } from 'react';

interface SignOutButtonProps {
  className?: string;
  children?: React.ReactNode;
}

export const SignOutButton: React.FC<SignOutButtonProps> = ({ 
  className = '',
  children 
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    // Check if electronAPI is available
    if (!window.electronAPI || !window.electronAPI.auth) {
      setError('Authentication API is not available');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.auth.signOut();
      
      if (!result.success) {
        setError(result.error || 'Failed to sign out');
      }
      // If successful, auth state will be updated via onAuthStateChanged listener
    } catch (err: any) {
      console.error('Error signing out:', err);
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleSignOut}
        disabled={isLoading}
        className={className}
        style={{
          padding: '8px 16px',
          fontSize: '14px',
          fontWeight: 500,
          color: '#333',
          backgroundColor: isLoading ? '#ccc' : '#f0f0f0',
          border: '1px solid #ddd',
          borderRadius: '4px',
          cursor: isLoading ? 'not-allowed' : 'pointer',
        }}
      >
        {isLoading ? 'Signing out...' : (children || 'Sign Out')}
      </button>
      {error && (
        <div style={{ color: 'red', marginTop: '8px', fontSize: '12px' }}>
          {error}
        </div>
      )}
    </div>
  );
};

