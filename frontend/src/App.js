import { useEffect, useRef, useState } from 'react';
import { Device } from '@twilio/voice-sdk';
import { Phone, PhoneOff, Power, Trash2, Moon, Sun, Sparkles, Zap, Shield, Activity } from 'lucide-react';
import './App.css';

function App() {
  const [device, setDevice] = useState(null);
  const [status, setStatus] = useState('idle');
  const [identity] = useState('delivery_user');
  const [darkMode, setDarkMode] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const connRef = useRef(null);
  const timerRef = useRef(null);
  const callStartRef = useRef(null);
  const [duration, setDuration] = useState(0);

  const formatDuration = (sec) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const startTimer = () => {
    callStartRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setDuration((Date.now() - callStartRef.current) / 1000);
    }, 500);
  };

  const stopTimer = () => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    callStartRef.current = null;
    setDuration(0);
  };

  const fetchToken = async () => {
    const res = await fetch(`http://localhost:3000/token?identity=${identity}`);
    const { token } = await res.json();
    return token;
  };

  const attachConnectionEvents = (conn) => {
    conn.on('accept', () => {
      setStatus('inCall');
      startTimer();
    });
    conn.on('disconnect', () => {
      setStatus('ready');
      connRef.current = null;
      stopTimer();
    });
    conn.on('reconnecting', () => console.log('Reconnecting...'));
    conn.on('reconnected', () => console.log('Reconnected'));
    conn.on('error', (e) => console.warn('Connection error:', e?.message || e));
  };

  const initDevice = async () => {
    if (device) return;
    try {
      setStatus('registering');
      const token = await fetchToken();
      await navigator.mediaDevices.getUserMedia({ audio: true });

      const twilioDevice = new Device(token, {
        codecPreferences: ['opus', 'pcmu'],
        edge: 'roaming',
        debug: true,
      });

      twilioDevice.on('error', (err) => {
        console.warn('Device error:', err?.message || err);
        if (status !== 'inCall' && status !== 'calling') setStatus('idle');
      });

      twilioDevice.on('registered', () => setStatus('ready'));
      twilioDevice.on('unregistered', () => {
        if (status !== 'inCall' && status !== 'calling') setStatus('idle');
      });

      twilioDevice.on('incoming', (conn) => {
        attachConnectionEvents(conn);
        conn.accept();
      });

      twilioDevice.on('tokenWillExpire', async () => {
        try {
          const newToken = await fetchToken();
          await twilioDevice.updateToken(newToken);
        } catch (e) {
          console.warn('Token refresh failed:', e?.message || e);
        }
      });

      setDevice(twilioDevice);
      await twilioDevice.register();
    } catch (err) {
      console.error('Error initializing device:', err?.message || err);
      setStatus('idle');
    }
  };

  const makeCall = async () => {
    if (!device) return alert('Device not ready');
    try {
      setStatus('calling');
      const conn = await device.connect();
      connRef.current = conn;
      attachConnectionEvents(conn);
    } catch (e) {
      console.error('connect() failed:', e?.message || e);
      setStatus('ready');
    }
  };

  const endCall = () => {
    try {
      if (connRef.current) {
        connRef.current.disconnect();
      } else if (device) {
        device.disconnectAll && device.disconnectAll();
      }
      setStatus('ready');
      stopTimer();
    } catch (e) {
      console.error('Error ending call:', e?.message || e);
    }
  };

  const destroyDevice = async () => {
    try {
      endCall();
      if (device) {
        await device.destroy();
        setDevice(null);
        setStatus('idle');
      }
    } catch (e) {
      console.error('Error destroying device:', e?.message || e);
    }
  };

  useEffect(() => {
    return () => {
      try { if (device) device.destroy(); } catch {}
      clearInterval(timerRef.current);
    };
  }, [device]);

  const isReady = status === 'ready';
  const isCalling = status === 'calling' || status === 'inCall';

  const statusLabel = {
    idle: 'Not registered',
    registering: 'Registering...',
    ready: 'Ready to receive calls',
    calling: 'Calling...',
    inCall: 'In call',
  }[status];

  const getStatusColor = () => {
    switch (status) {
      case 'ready': return '#22c55e';
      case 'registering': return '#facc15';
      case 'calling':
      case 'inCall': return '#8b5cf6';
      default: return '#64748b';
    }
  };

  return (
    <div className={darkMode ? 'dark' : 'light'}>
      {/* Background Orbs */}
      <div className="bg-orb orb-1"></div>
      <div className="bg-orb orb-2"></div>

      <div className="container">
        {/* Header */}
        <div className="header">
          <div className="logo">
            <div className="logo-icon">
              <Sparkles size={24} color="white" strokeWidth={2.5} />
            </div>
            <span className="logo-text">VoiceAI</span>
          </div>

          <div className="header-right">
            <div className="status-badge" style={{ '--status-color': getStatusColor() }}>
              <span className="status-dot"></span>
              <span>{statusLabel}</span>
            </div>

            <button
              className="theme-toggle"
              onClick={() => setDarkMode(!darkMode)}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>

          </div>
        </div>

        {/* Main Content */}
        <div className="main-content">
          {/* Hero Section */}
          <div className="hero">
            <div className="hero-badge">
              <Activity size={16} />
              <span>Twilio Voice SDK • {identity}</span>
            </div>
            <h1>Voice Agent<br />Control Panel</h1>
            <p>Manage your Twilio voice devices and handle incoming calls with intelligent automation.</p>
          </div>

          {/* Glass Card */}
          <div className="glass-card">
            <div className="card-controls">
              <button
                className="control-button"
                onClick={initDevice}
                disabled={status !== 'idle'}
                title="Register the Twilio Device"
              >
                <Power size={20} />
                <span>Initialize Device</span>
              </button>

              <button
                className="control-button primary"
                onClick={makeCall}
                disabled={!isReady || isCalling}
                title="Start an outbound call"
              >
                <Phone size={20} />
                <span>Start Call</span>
              </button>

              <button
                className="control-button danger"
                onClick={endCall}
                disabled={!isCalling}
                title="End the current call"
              >
                <PhoneOff size={20} />
                <span>End Call</span>
              </button>

              <button
                className="control-button ghost"
                onClick={destroyDevice}
                disabled={status === 'idle'}
                title="Unregister and destroy device"
              >
                <Trash2 size={20} />
                <span>Destroy Device</span>
              </button>
            </div>

            <div className="card-info">
              <div className="info-item">
                <div className="info-label">Call Status</div>
                <div className="info-value">{statusLabel}</div>
              </div>
              <div className="info-item">
                <div className="info-label">Call Duration</div>
                <div className="info-value info-monospace">{formatDuration(duration)}</div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export default App;