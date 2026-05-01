import React, { createContext, useContext, useEffect, useState } from 'react';
import { auth } from '../config/firebase';
import { User, onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { api } from '../services/api';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  token: string | null;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Get the token and attach it to axios defaults
        const idToken = await currentUser.getIdToken();
        setToken(idToken);
        api.defaults.headers.common['Authorization'] = `Bearer ${idToken}`;
      } else {
        setToken(null);
        delete api.defaults.headers.common['Authorization'];
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const logout = async () => {
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, token }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
