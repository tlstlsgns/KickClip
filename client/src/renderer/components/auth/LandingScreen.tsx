/**
 * LandingScreen
 * 
 * Landing screen logic for auth state:
 * - Shows loading state while auth initializes
 * - Shows "Sign in with Google" when logged out
 * - Shows user email and SignOutButton when logged in
 */

import React from 'react';
import { useAuth } from './AuthProvider';
import { SignInButton } from './SignInButton';
import { SignOutButton } from './SignOutButton';

export const LandingScreen: React.FC = () => {
  const { user, loading } = useAuth();

  // Show loading state until initial auth state is resolved
  if (loading) {
    return (
      <div style={{
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '14px',
          color: 'rgba(0, 0, 0, 0.6)',
        }}>
          <div style={{
            width: '16px',
            height: '16px',
            border: '2px solid rgba(0, 0, 0, 0.2)',
            borderTopColor: 'rgba(0, 0, 0, 0.6)',
            borderRadius: '50%',
            animation: 'spin 0.6s linear infinite',
          }} />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  // Show sign-in button when logged out
  if (!user) {
    return (
      <div style={{
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <SignInButton />
      </div>
    );
  }

  // Show user info and sign-out button when logged in
  return (
    <div style={{
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
    }}>
      <div style={{
        flex: 1,
        minWidth: 0, // Allow text truncation
      }}>
        <div style={{
          fontSize: '14px',
          fontWeight: 500,
          color: '#000',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {user.email}
        </div>
        {user.displayName && (
          <div style={{
            fontSize: '12px',
            color: 'rgba(0, 0, 0, 0.6)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: '2px',
          }}>
            {user.displayName}
          </div>
        )}
      </div>
      <SignOutButton />
    </div>
  );
};

