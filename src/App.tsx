import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, firebaseConfig } from './lib/firebase';
import { swSend } from './lib/sw';
import { localDB } from './lib/db';
import { useStore } from './store/useStore';
import NameModal from './components/NameModal';
import Dashboard from './pages/Dashboard';
import ChatScreen from './pages/ChatScreen';

function getDeviceId(): string {
  let id = localStorage.getItem('chatrix_device_id');
  if (!id) {
    id = (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));
    localStorage.setItem('chatrix_device_id', id);
  }
  return id;
}

function getDeviceName(): string {
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return `${browser} · ${os}`;
}

function DeviceManager() {
  const user = useStore((s) => s.user);
  const setUser = useStore((s) => s.setUser);
  const navigate = useNavigate();
  const deviceId = getDeviceId();

  useEffect(() => {
    if (!user) return;
    const deviceRef = doc(db, 'users', user.uid, 'devices', deviceId);

    const heartbeat = () => {
      setDoc(deviceRef, {
        name: getDeviceName(),
        lastSeen: serverTimestamp(),
        online: true,
      }, { merge: true }).catch(() => {});
    };

    const setOffline = () => {
      updateDoc(deviceRef, { online: false }).catch(() => {});
    };

    heartbeat();
    const interval = setInterval(heartbeat, 60000);
    window.addEventListener('beforeunload', setOffline);
    window.addEventListener('pagehide', setOffline);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setOffline();
      else heartbeat();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const unsub = onSnapshot(deviceRef, (snap) => {
      if (snap.exists() && snap.data()?.revoked === true) {
        localDB.userProfile.clear().then(() => {
          setUser(null);
          navigate('/');
        });
      }
    });

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', setOffline);
      window.removeEventListener('pagehide', setOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
    };
  }, [user, deviceId, setUser, navigate]);

  return null;
}

export default function App() {
  const { user, setUser } = useStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    localDB.userProfile.toArray().then((profiles) => {
      if (profiles.length > 0) {
        setUser(profiles[0]);
      }
      setLoading(false);
    });
  }, [setUser]);

  // Sync Firebase config + user UID to service worker for background notifications
  useEffect(() => {
    swSend({ type: 'FIREBASE_CONFIG', config: firebaseConfig });
  }, []);

  useEffect(() => {
    if (user) {
      swSend({ type: 'USER_UID', uid: user.uid });
    }
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-dvh bg-black">
        <div className="w-8 h-8 border-2 border-[#333] border-t-[#007AFF] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      {!user && <NameModal />}
      <DeviceManager />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/chat/:code" element={<ChatScreen />} />
      </Routes>
    </BrowserRouter>
  );
}
