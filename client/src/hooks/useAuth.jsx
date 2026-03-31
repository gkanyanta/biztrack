import { createContext, useContext, useState, useEffect } from 'react';
import { login as apiLogin, getMe } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('biztrack_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('biztrack_token');
    if (token) {
      getMe().then(res => {
        setUser(res.data);
        localStorage.setItem('biztrack_user', JSON.stringify(res.data));
      }).catch(() => {
        localStorage.removeItem('biztrack_token');
        localStorage.removeItem('biztrack_user');
        setUser(null);
      }).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username, password) => {
    const res = await apiLogin({ username, password });
    localStorage.setItem('biztrack_token', res.data.token);
    localStorage.setItem('biztrack_user', JSON.stringify(res.data.user));
    setUser(res.data.user);
    return res.data;
  };

  const logout = () => {
    localStorage.removeItem('biztrack_token');
    localStorage.removeItem('biztrack_user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
